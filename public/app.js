// DOM Elements
const lastUpdateEl = document.getElementById("last-update");
const statsGridEl = document.getElementById("stats-grid");
const interfacesBodyEl = document.getElementById("interfaces-body");
const messagesBodyEl = document.getElementById("messages-body");
const recentMessagesBodyEl = document.getElementById("recent-messages-body");
const interfacesBySystemEl = document.getElementById("interfaces-by-system");
const interfaceSystemFilterEl = document.getElementById("interface-system-filter");
const interfaceSystemOptionsEl = document.getElementById("interface-system-options");
const messageSystemFilterEl = document.getElementById("message-system-filter");
const messageSystemOptionsEl = document.getElementById("message-system-options");
const messageFlowFilterEl = document.getElementById("message-flow-filter");
const messageFlowOptionsEl = document.getElementById("message-flow-options");
const messageStatusFilterEl = document.getElementById("message-status-filter");
const messageTimeFilterEl = document.getElementById("message-time-filter");
const messageHeaderFilterEl = document.getElementById("message-header-filter");
const messageInterfaceContextEl = document.getElementById("message-interface-context");
const clearMessageInterfaceFilterBtnEl = document.getElementById("clear-message-interface-filter-btn");
const refreshBtnEl = document.getElementById("refresh-btn");
const autoRefreshEl = document.getElementById("auto-refresh");
const errorBannerEl = document.getElementById("error-banner");
const serviceKeyFileEl = document.getElementById("service-key-file");
const serviceKeyJsonEl = document.getElementById("service-key-json");
const applyServiceKeyBtnEl = document.getElementById("apply-service-key-btn");
const configStatusEl = document.getElementById("config-status");
const connectionStatusEl = document.getElementById("connection-status");
const syncMessageCacheBtnEl = document.getElementById("sync-message-cache-btn");
const refreshMessageCacheStatusBtnEl = document.getElementById("refresh-message-cache-status-btn");
const syncMessageCacheLimitEl = document.getElementById("sync-message-cache-limit");
const messageCacheStatusEl = document.getElementById("message-cache-status");
const bulkPackageFilterEl = document.getElementById("bulk-package-filter");
const bulkPackageOptionsEl = document.getElementById("bulk-package-options");
const bulkIflowFilterEl = document.getElementById("bulk-iflow-filter");
const bulkIflowOptionsEl = document.getElementById("bulk-iflow-options");
const bulkStatusFilterEl = document.getElementById("bulk-status-filter");
const bulkTimeFilterEl = document.getElementById("bulk-time-filter");
const bulkLimitMplEl = document.getElementById("bulk-limit-mpl");
const bulkDownloadAttachmentsBtnEl = document.getElementById("bulk-download-attachments-btn");
const bulkDownloadStatusEl = document.getElementById("bulk-download-status");
const bulkDownloadProgressEl = document.getElementById("bulk-download-progress");
const bulkDownloadProgressBarEl = document.getElementById("bulk-download-progress-bar");
const bulkDownloadProgressTextEl = document.getElementById("bulk-download-progress-text");
const attachmentViewerEl = document.getElementById("attachment-viewer");
const attachmentViewerMetaEl = document.getElementById("attachment-viewer-meta");
const attachmentViewerBodyEl = document.getElementById("attachment-viewer-body");
const closeAttachmentViewerBtnEl = document.getElementById("close-attachment-viewer-btn");

// State
let overviewCache = {
  stats: null,
  interfaces: [],
  messages: [],
  systems: [],
  flows: {},
  allFlows: []
};

let timerId = null;
let currentPage = "dashboard";
let messagesPageLoaded = false;
let interfacesPageLoaded = false;
let isMessagesPageLoading = false;
let isInterfacesPageLoading = false;
let messagesScopedToActiveInterface = false;
let cacheStatusPollTimerId = null;
let activeInterfaceMessageFilter = null;
const attachmentsByMplId = new Map();
const attachmentDiagnosticsByMplId = new Map();
const attachmentsLoading = new Set();
let bulkExportProgressPollTimerId = null;

// Extract system name from interface/flow name
function extractSystem(name) {
  if (!name) return "UNKNOWN";
  
  const str = String(name);
  
  // Try pattern: _to_SYSTEM or _from_SYSTEM (e.g., SAP_to_INOPERA -> INOPERA)
  const toMatch = str.match(/_to_([A-Z0-9]+)(?:_|$)/i);
  if (toMatch) return toMatch[1].toUpperCase();
  
  const fromMatch = str.match(/_from_([A-Z0-9]+)(?:_|$)/i);
  if (fromMatch) return fromMatch[1].toUpperCase();
  
  // Try common ERP patterns at end: _MYPLAN, _INOPERA, _SAP
  const erpMatch = str.match(/_([A-Z]{3,})$/);
  if (erpMatch) {
    const potential = erpMatch[1].toUpperCase();
    // Filter out common non-system suffixes
    if (!["VER", "TEST", "PROD"].includes(potential)) {
      return potential;
    }
  }
  
  // Fallback: first word before underscore (the InterfaceID) as system placeholder
  const firstWord = str.split(/[-_\s]/)[0];
  return firstWord || "OTHER";
}

function getSystemFromPackage(pkg) {
  // If package is explicitly set and not UNKNOWN, use it
  if (pkg && pkg !== "UNKNOWN") {
    return pkg;
  }
  
  // Fallback will be provided by caller with name-based extraction
  return null;
}

function getSystemForInterface(item) {
  const fromPackage = getSystemFromPackage(item.package);
  if (fromPackage) return fromPackage;

  return "UNKNOWN";
}

function getSystemForMessage(item) {
  const fromPackage = getSystemFromPackage(item.package);
  if (fromPackage) return fromPackage;

  return "UNKNOWN";
}

// Page Navigation
function showPage(pageName) {
  currentPage = pageName;
  
  document.querySelectorAll(".page").forEach((page) => {
    page.classList.remove("active");
  });
  
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.classList.remove("active");
  });
  
  const pageEl = document.getElementById(`page-${pageName}`);
  if (pageEl) {
    pageEl.classList.add("active");
  }
  
  const tabEl = document.querySelector(`.tab[data-page="${pageName}"]`);
  if (tabEl) {
    tabEl.classList.add("active");
  }

  if (pageName === "interfaces") {
    loadInterfacesForPage();
  }

  if (pageName === "messages") {
    loadMessagesForPage(false, activeInterfaceMessageFilter);
  }
  
  renderCurrentPage();
}

function initNavigation() {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      const page = tab.dataset.page;
      if (page) {
        showPage(page);
      }
    });
  });
}

// Utilities
function setConfigStatus(message, isError = false) {
  if (!configStatusEl) {
    return;
  }

  configStatusEl.textContent = message || "";
  configStatusEl.classList.toggle("error-inline", Boolean(isError));
}

function formatDate(input) {
  if (!input) {
    return "-";
  }

  const date = new Date(input);
  if (Number.isNaN(date.getTime())) {
    return String(input);
  }

  return new Intl.DateTimeFormat("it-IT", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZone: "Europe/Rome"
  }).format(date);
}

function escapeHtml(input) {
  return String(input ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatFlowCompact(flowName) {
  const safe = escapeHtml(flowName || "N/D");
  return safe.replace(/_/g, "_<wbr>").replace(/\//g, "/<wbr>");
}

function formatCustomHeaders(customHeaders) {
  if (!Array.isArray(customHeaders) || customHeaders.length === 0) {
    return "-";
  }

  return customHeaders
    .slice(0, 3)
    .map((header) => `${escapeHtml(header.name)}: ${escapeHtml(header.value || "")}`)
    .join("<br>");
}

function formatAttachmentSize(value) {
  const size = Number(value);
  if (Number.isNaN(size) || size <= 0) {
    return "";
  }

  if (size < 1024) {
    return `${size} B`;
  }

  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }

  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function formatAttachmentDiagnostics(diagnostics) {
  if (!diagnostics || typeof diagnostics !== "object") {
    return "";
  }

  const bits = [];
  if (Number(diagnostics.messageStoreEntriesCount || 0) > 0) {
    bits.push(`store: ${Number(diagnostics.messageStoreEntriesCount)}`);
  }

  if (Number(diagnostics.runsCount || 0) > 1) {
    bits.push(`runs: ${Number(diagnostics.runsCount)}`);
  }

  if (diagnostics.hasErrorInformation) {
    bits.push("error info presente");
  }

  if (diagnostics.archivingLogAttachments === false) {
    bits.push("archiving allegati: off");
  }

  return bits.join(" - ");
}

function formatAttachmentsCell(item) {
  const mplId = String(item.mplId || item.id || "");
  if (!mplId) {
    return "";
  }

  const cached = attachmentsByMplId.get(mplId);
  if (!cached) {
    // Keep UX explicit: known rows show attachments, otherwise allow on-demand loading.
    if (item.attachmentsLoaded === true) {
      const known = Array.isArray(item.attachments) ? item.attachments : [];
      if (known.length === 0) {
        return "<span class='muted compact'>Nessun allegato</span>";
      }
      attachmentsByMplId.set(mplId, known);
      return known
        .map((att) => {
          const name = escapeHtml(att.name || "attachment");
          const size = formatAttachmentSize(att.payloadSize);
          const meta = [size, att.contentType].filter(Boolean).join(" - ");
          const downloadUrl = escapeHtml(att.downloadUrl || "");
          if (!downloadUrl) {
            return `<span class="attachment-item"><span>${name}</span>${meta ? `<small>${meta}</small>` : ""}</span>`;
          }
          return `<a class="attachment-item" href="${downloadUrl}" data-attachment-url="${downloadUrl}" data-attachment-name="${name}">${name}${meta ? `<small>${escapeHtml(meta)}</small>` : ""}</a>`;
        })
        .join("");
    }

    if (attachmentsLoading.has(mplId)) {
      return "<span class='muted compact'>Caricamento allegati...</span>";
    }

    return `<a href="#" class="btn btn-compact" data-action="open-attachments" data-mpl-id="${escapeHtml(mplId)}">Carica allegati</a>`;
  }

  const attachments = cached || [];
  if (attachments.length === 0) {
    const diagnostics = attachmentDiagnosticsByMplId.get(mplId);
    const diagLabel = formatAttachmentDiagnostics(diagnostics);
    if (!diagLabel) {
      return "<span class='muted compact'>Nessun allegato</span>";
    }

    return `<span class='muted compact'>Nessun allegato<br>${escapeHtml(diagLabel)}</span>`;
  }

  return attachments
    .map((att) => {
      const name = escapeHtml(att.name || "attachment");
      const size = formatAttachmentSize(att.payloadSize);
      const meta = [size, att.contentType].filter(Boolean).join(" - ");
      const downloadUrl = escapeHtml(att.downloadUrl || "");
      if (!downloadUrl) {
        return `<span class="attachment-item"><span>${name}</span>${meta ? `<small>${meta}</small>` : ""}</span>`;
      }

      return `<a class="attachment-item" href="${downloadUrl}" data-attachment-url="${downloadUrl}" data-attachment-name="${name}">${name}${meta ? `<small>${escapeHtml(meta)}</small>` : ""}</a>`;
    })
    .join("");
}

function closeAttachmentViewer() {
  if (!attachmentViewerEl) {
    return;
  }

  attachmentViewerEl.classList.add("hidden");
  if (attachmentViewerMetaEl) {
    attachmentViewerMetaEl.textContent = "";
  }

  if (attachmentViewerBodyEl) {
    attachmentViewerBodyEl.innerHTML = "";
  }
}

function openAttachmentViewerLoading(name) {
  if (!attachmentViewerEl || !attachmentViewerBodyEl || !attachmentViewerMetaEl) {
    return;
  }

  attachmentViewerEl.classList.remove("hidden");
  attachmentViewerMetaEl.textContent = name ? `Allegato: ${name}` : "Caricamento allegato...";
  attachmentViewerBodyEl.innerHTML = "<p class='muted'>Caricamento anteprima...</p>";
}

async function fetchAttachmentPreview(downloadUrl) {
  const url = new URL(downloadUrl, window.location.origin);
  const uri = url.searchParams.get("uri") || "";
  const name = url.searchParams.get("name") || "attachment";

  const previewResponse = await fetch(
    `/api/cpi/attachments/preview?uri=${encodeURIComponent(uri)}&name=${encodeURIComponent(name)}`
  );

  if (!previewResponse.ok) {
    const payload = await previewResponse.json().catch(() => ({}));
    throw new Error(payload.error || "Impossibile caricare anteprima allegato");
  }

  return previewResponse.json();
}

async function openAttachmentViewer(downloadUrl, label) {
  openAttachmentViewerLoading(label || "");

  try {
    const data = await fetchAttachmentPreview(downloadUrl);
    if (!attachmentViewerBodyEl || !attachmentViewerMetaEl || !attachmentViewerEl) {
      return;
    }

    const sizeLabel = formatAttachmentSize(data.size);
    attachmentViewerMetaEl.textContent = `${data.name || label || "allegato"} - ${data.contentType || "n/d"}${sizeLabel ? ` - ${sizeLabel}` : ""}`;

    if (data.isText && typeof data.text === "string") {
      const notice = data.truncated ? "\n\n[Anteprima troncata per dimensione]" : "";
      attachmentViewerBodyEl.innerHTML = `<pre>${escapeHtml(data.text + notice)}</pre>`;
    } else {
      attachmentViewerBodyEl.innerHTML = `
        <p class="muted">Questo allegato non e testuale e non puo essere mostrato inline.</p>
        <p><a class="btn" href="${escapeHtml(data.downloadUrl || downloadUrl)}" target="_blank" rel="noopener noreferrer">Apri file</a></p>
      `;
    }

    attachmentViewerEl.classList.remove("hidden");
  } catch (error) {
    if (!attachmentViewerBodyEl || !attachmentViewerMetaEl || !attachmentViewerEl) {
      return;
    }

    attachmentViewerMetaEl.textContent = label || "allegato";
    attachmentViewerBodyEl.innerHTML = `<p class='error-inline'>${escapeHtml(error.message)}</p>`;
    attachmentViewerEl.classList.remove("hidden");
  }
}

function formatMplLink(item) {
  const mplId = escapeHtml(item.mplId || item.id || "n/a");
  const href = item.logLink ? String(item.logLink).trim() : "";
  if (!href) {
    return `<span class="system-badge mpl-id">${mplId}</span>`;
  }

  return `<a class="system-badge mpl-id mpl-link" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${mplId}</a>`;
}

function setActiveInterfaceMessageFilter(filter) {
  activeInterfaceMessageFilter = filter || null;

  if (!messageInterfaceContextEl || !clearMessageInterfaceFilterBtnEl) {
    return;
  }

  if (!activeInterfaceMessageFilter) {
    messageInterfaceContextEl.classList.add("hidden");
    messageInterfaceContextEl.textContent = "";
    clearMessageInterfaceFilterBtnEl.classList.add("hidden");
    return;
  }

  const label = activeInterfaceMessageFilter.label || activeInterfaceMessageFilter.name || activeInterfaceMessageFilter.id;
  messageInterfaceContextEl.classList.remove("hidden");
  messageInterfaceContextEl.textContent = `Filtro interfaccia: ${label}`;
  clearMessageInterfaceFilterBtnEl.classList.remove("hidden");
}

function getTimeThreshold(filterValue) {
  const now = Date.now();
  switch (filterValue) {
    case "5m":
      return now - 5 * 60 * 1000;
    case "15m":
      return now - 15 * 60 * 1000;
    case "30m":
      return now - 30 * 60 * 1000;
    case "1h":
      return now - 60 * 60 * 1000;
    case "6h":
      return now - 6 * 60 * 60 * 1000;
    case "24h":
      return now - 24 * 60 * 60 * 1000;
    case "7d":
      return now - 7 * 24 * 60 * 60 * 1000;
    case "30d":
      return now - 30 * 24 * 60 * 60 * 1000;
    default:
      return null;
  }
}

function getMessageTimestamp(item) {
  const raw = item.logEnd || item.logStart;
  if (!raw) return null;

  // Handle CPI OData date format: /Date(1709731200000)/
  const odataMatch = String(raw).match(/\/Date\((\d+)\)\//);
  if (odataMatch) {
    const millis = Number(odataMatch[1]);
    return Number.isNaN(millis) ? null : millis;
  }

  const ts = new Date(raw).getTime();
  if (!Number.isNaN(ts)) return ts;

  // Fallback: if timezone is missing, try UTC parsing.
  const utcTs = new Date(`${raw}Z`).getTime();
  return Number.isNaN(utcTs) ? null : utcTs;
}

function badgeClass(status) {
  const normalized = String(status || "").toLowerCase();

  if (normalized.includes("running")) {
    return "running";
  }

  if (normalized.includes("success")) {
    return "success";
  }

  if (normalized.includes("error") || normalized.includes("failed")) {
    return "failed";
  }

  if (normalized.includes("processing")) {
    return "processing";
  }

  if (normalized.includes("stopped")) {
    return "stopped";
  }

  return "processing";
}

function setError(message) {
  if (!message) {
    errorBannerEl.classList.add("hidden");
    errorBannerEl.textContent = "";
    return;
  }

  errorBannerEl.classList.remove("hidden");
  errorBannerEl.textContent = message;
}

function setMessageCacheStatus(message, isError = false) {
  if (!messageCacheStatusEl) {
    return;
  }

  messageCacheStatusEl.classList.toggle("error-inline", Boolean(isError));
  messageCacheStatusEl.innerHTML = message || "";
}

function setBulkDownloadStatus(message, isError = false) {
  if (!bulkDownloadStatusEl) {
    return;
  }

  bulkDownloadStatusEl.classList.toggle("error-inline", Boolean(isError));
  bulkDownloadStatusEl.textContent = message || "";
}

function stopBulkExportProgressPolling() {
  if (bulkExportProgressPollTimerId) {
    clearInterval(bulkExportProgressPollTimerId);
    bulkExportProgressPollTimerId = null;
  }
}

function setBulkExportProgress(percent, text = "") {
  if (!bulkDownloadProgressEl || !bulkDownloadProgressBarEl || !bulkDownloadProgressTextEl) {
    return;
  }

  const safePercent = Math.max(0, Math.min(100, Number(percent) || 0));
  bulkDownloadProgressEl.classList.remove("hidden");
  bulkDownloadProgressBarEl.style.width = `${safePercent}%`;

  const progressTrack = bulkDownloadProgressEl.querySelector(".progress-track");
  if (progressTrack) {
    progressTrack.setAttribute("aria-valuenow", String(Math.round(safePercent)));
  }

  bulkDownloadProgressTextEl.textContent = text || `${Math.round(safePercent)}%`;
}

function hideBulkExportProgress() {
  if (!bulkDownloadProgressEl || !bulkDownloadProgressBarEl || !bulkDownloadProgressTextEl) {
    return;
  }

  bulkDownloadProgressEl.classList.add("hidden");
  bulkDownloadProgressBarEl.style.width = "0%";
  bulkDownloadProgressTextEl.textContent = "0%";
}

function computeBulkProgressPercent(state) {
  const total = Number(state?.totalMpl || 0);
  const done = Number(state?.mplProcessed || 0);
  if (total <= 0) {
    return state?.status === "completed" ? 100 : 0;
  }

  return Math.round((done / total) * 100);
}

async function fetchBulkExportProgress(progressId) {
  const response = await fetch(`/api/cpi/attachments/export/progress/${encodeURIComponent(progressId)}`);
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || "Impossibile leggere stato export");
  }

  return response.json();
}

function startBulkExportProgressPolling(progressId) {
  stopBulkExportProgressPolling();

  const poll = async () => {
    try {
      const payload = await fetchBulkExportProgress(progressId);
      const state = payload.state || {};
      const percent = computeBulkProgressPercent(state);
      const label = `${percent}% - MPL ${state.mplProcessed || 0}/${state.totalMpl || 0} - allegati ${state.attachmentsAdded || 0}`;
      setBulkExportProgress(percent, label);

      if (state.status === "finalizing") {
        setBulkExportProgress(99, "Finalizzazione ZIP...");
      }

      if (state.status === "completed") {
        setBulkExportProgress(100, `100% - Completato (allegati: ${state.attachmentsAdded || 0})`);
        stopBulkExportProgressPolling();
      }

      if (state.status === "failed") {
        stopBulkExportProgressPolling();
        setBulkDownloadStatus(state.message || "Export fallito", true);
      }
    } catch (_error) {
      // Ignore transient polling errors while the export request is still active.
    }
  };

  poll();
  bulkExportProgressPollTimerId = setInterval(poll, 1200);
}

function formatCacheStatus(meta, inProgress) {
  if (!meta) {
    return "Stato cache non disponibile.";
  }

  const lines = [
    `<span><strong>Stato:</strong> ${inProgress ? "Sincronizzazione in corso" : "Idle"}</span>`,
    `<span><strong>Messaggi in cache:</strong> ${meta.count || 0}</span>`,
    `<span><strong>Limite cache:</strong> ${meta.maxItems || "n/d"}${meta.truncated ? " (limite raggiunto)" : ""}</span>`,
    `<span><strong>Finestra:</strong> ultimi ${meta.windowDays || 30} giorni</span>`,
    `<span><strong>Copertura sorgente:</strong> ${meta.downloadedAllAvailable ? "Completa" : "Parziale"}</span>`
  ];

  if (meta.oldestLogAt || meta.newestLogAt) {
    lines.push(`<span><strong>Range log:</strong> ${formatDate(meta.oldestLogAt)} -> ${formatDate(meta.newestLogAt)}</span>`);
  }

  if (meta.lastSyncStartedAt) {
    lines.push(`<span><strong>Ultimo avvio sync:</strong> ${formatDate(meta.lastSyncStartedAt)}</span>`);
  }

  if (meta.lastSyncCompletedAt) {
    lines.push(`<span><strong>Ultimo completamento:</strong> ${formatDate(meta.lastSyncCompletedAt)}</span>`);
  }

  if (meta.pagesFetched || meta.rawFetched) {
    lines.push(`<span><strong>Progress:</strong> pagine ${meta.pagesFetched || 0}, record ${meta.rawFetched || 0}</span>`);
  }

  if (meta.targetDownloadCount) {
    const done = Number(meta.rawFetched || 0);
    const target = Number(meta.targetDownloadCount || 0);
    const percent = Number(meta.progressPercent || 0);
    lines.push(`<span><strong>Download log:</strong> ${done} / ${target} (${percent}%)</span>`);
  } else if (meta.progressPercent !== null && meta.progressPercent !== undefined) {
    lines.push(`<span><strong>Download log:</strong> ${Number(meta.progressPercent || 0)}%</span>`);
  }

  if (meta.attachmentsPrefetchEnabled) {
    lines.push(
      `<span><strong>Precarica allegati:</strong> ${meta.attachmentsProcessed || 0} / ${meta.attachmentsPrefetchLimit || 0} (con allegati: ${meta.attachmentsWithItems || 0})</span>`
    );
    lines.push(
      `<span><strong>Allegati precaricati:</strong> ${meta.attachmentsFullyScanned ? "completi" : "parziali"}</span>`
    );
  }

  if (meta.lastSyncError) {
    lines.push(`<span><strong>Errore ultimo sync:</strong> ${escapeHtml(meta.lastSyncError)}</span>`);
  }

  return `<span class="cache-status-lines">${lines.join("")}</span>`;
}

// Extract Systems and Flows from cache (run once after loading cache)
// Populate system filters - usa l'indice dei sistemi se disponibile
function populateSystemFilters() {
  try {
    const interfacePackages = new Set();
    let messagePackages = new Set();
    let messageFlows = new Set();
    const selectedPackage = String(messageSystemFilterEl?.value || "").trim();

  // Se abbiamo l'indice completo dei sistemi, usalo
  if (overviewCache.systems && overviewCache.systems.length > 0) {
    messagePackages = new Set(overviewCache.systems);
    messageFlows = new Set(overviewCache.allFlows || []);
  } else {
    // Fallback: estrai da messaggi (per compatibilità se l'indice non è caricato)
    (overviewCache.messages || []).forEach((item) => {
      const pkg = String(item.package || "").trim();
      const iflow = String(item.integrationFlow || "").trim();

      if (pkg && pkg !== "UNKNOWN") {
        messagePackages.add(pkg);
      }

      if (iflow && (!selectedPackage || pkg === selectedPackage)) {
        messageFlows.add(iflow);
      }
    });

    // Se è selezionato un package specifico, filtra i flow
    if (selectedPackage && overviewCache.flows && typeof overviewCache.flows === 'object' && overviewCache.flows[selectedPackage]) {
      messageFlows = new Set(overviewCache.flows[selectedPackage]);
    }
  }

  // Estrai da interfacce
  (overviewCache.interfaces || []).forEach((item) => {
    const ifacePackage = String(item.package || "").trim();
    const ifaceName = String(item.name || "").trim();

    if (ifacePackage && ifacePackage !== "UNKNOWN") {
      interfacePackages.add(ifacePackage);
    }

    if (ifaceName && (!selectedPackage || ifacePackage === selectedPackage)) {
      messageFlows.add(ifaceName);
    }
  });

  const sortedInterfacePackages = Array.from(interfacePackages).sort();
  const sortedMessagePackages = Array.from(messagePackages).sort();
  const sortedMessageFlows = Array.from(messageFlows).sort((a, b) => a.localeCompare(b));

  const updateSystemInput = (inputEl, datalistEl, systems) => {
    if (!inputEl || !datalistEl) {
      return;
    }

    const currentValue = (inputEl.value || "").trim();
    datalistEl.innerHTML = systems.map((sys) => `<option value="${sys}"></option>`).join("");

    if (currentValue && !systems.includes(currentValue)) {
      inputEl.value = "";
    }
  };
  
  updateSystemInput(interfaceSystemFilterEl, interfaceSystemOptionsEl, sortedInterfacePackages);
  updateSystemInput(messageSystemFilterEl, messageSystemOptionsEl, sortedMessagePackages);
  updateSystemInput(messageFlowFilterEl, messageFlowOptionsEl, sortedMessageFlows);
  } catch (error) {
    console.error("Errore in populateSystemFilters:", error);
  }
}

function updateMessageFlowsForSystem() {
  try {
    // Aggiorna i flow disponibili in base al sistema selezionato usando l'indice se disponibile
    const selectedSystem = (messageSystemFilterEl?.value || "").trim();
    let flowsForSystem = new Set();

  // Se abbiamo l'indice completo, usalo
  if (selectedSystem && overviewCache.flows && typeof overviewCache.flows === 'object' && overviewCache.flows[selectedSystem]) {
    flowsForSystem = new Set(overviewCache.flows[selectedSystem]);
  } else if (selectedSystem) {
    // Fallback: estrai da messaggi
    (overviewCache.messages || []).forEach((item) => {
      const pkg = String(item.package || "").trim();
      const iflow = String(item.integrationFlow || "").trim();

      if (pkg === selectedSystem && iflow) {
        flowsForSystem.add(iflow);
      }
    });

    // Aggiungi anche i nomi delle interfacce per lo stesso package
    (overviewCache.interfaces || []).forEach((item) => {
      const ifacePackage = String(item.package || "").trim();
      const ifaceName = String(item.name || "").trim();

      if (ifacePackage === selectedSystem && ifaceName) {
        flowsForSystem.add(ifaceName);
      }
    });
  } else if (overviewCache.allFlows && overviewCache.allFlows.length > 0) {
    // Se nessun sistema è selezionato e abbiamo l'indice, mostra tutti i flow
    flowsForSystem = new Set(overviewCache.allFlows);
  } else {
    // Fallback: mostra tutti i flow dai messaggi
    (overviewCache.messages || []).forEach((item) => {
      const iflow = String(item.integrationFlow || "").trim();
      if (iflow) {
        flowsForSystem.add(iflow);
      }
    });

    // Aggiungi anche i nomi delle interfacce
    (overviewCache.interfaces || []).forEach((item) => {
      const ifaceName = String(item.name || "").trim();
      if (ifaceName) {
        flowsForSystem.add(ifaceName);
      }
    });
  }

  const sortedFlows = Array.from(flowsForSystem).sort((a, b) => a.localeCompare(b));
  
  if (messageFlowFilterEl && messageFlowOptionsEl) {
    const currentValue = (messageFlowFilterEl.value || "").trim();
    messageFlowOptionsEl.innerHTML = sortedFlows.map((flow) => `<option value="${flow}"></option>`).join("");
    
    // Se il flow corrente non è più valido per il sistema selezionato, pulisci il campo
    if (currentValue && !sortedFlows.includes(currentValue)) {
      messageFlowFilterEl.value = "";
    }
  }
  } catch (error) {
    console.error("Errore in updateMessageFlowsForSystem:", error);
  }
}

function populateBulkAttachmentFilters() {
  try {
    const updateInputWithOptions = (inputEl, datalistEl, values) => {
      if (!inputEl || !datalistEl) {
        return;
      }

      const sorted = Array.from(values).sort((a, b) => a.localeCompare(b));
      const currentValue = String(inputEl.value || "").trim();

      datalistEl.innerHTML = sorted.map((value) => `<option value="${escapeHtml(value)}"></option>`).join("");
      if (currentValue && !sorted.includes(currentValue)) {
        inputEl.value = "";
      }
    };

    const packageValues = new Set();
    const iflowValues = new Set();
    const selectedPackage = String(bulkPackageFilterEl?.value || "").trim();

  (overviewCache.messages || []).forEach((item) => {
    const pkg = String(item.package || "").trim();
    const iflow = String(item.integrationFlow || "").trim();

    if (pkg && pkg !== "UNKNOWN") {
      packageValues.add(pkg);
    }

    if (iflow && (!selectedPackage || pkg === selectedPackage)) {
      iflowValues.add(iflow);
    }
  });

  // Include display names from interfaces so users can filter/export by what they see in Interfacce.
  (overviewCache.interfaces || []).forEach((item) => {
    const ifacePackage = String(item.package || "").trim();
    const ifaceName = String(item.name || "").trim();

    if (ifacePackage && ifacePackage !== "UNKNOWN") {
      packageValues.add(ifacePackage);
    }

    if (ifaceName && (!selectedPackage || ifacePackage === selectedPackage)) {
      iflowValues.add(ifaceName);
    }
  });

  updateInputWithOptions(bulkPackageFilterEl, bulkPackageOptionsEl, packageValues);
  updateInputWithOptions(bulkIflowFilterEl, bulkIflowOptionsEl, iflowValues);
  } catch (error) {
    console.error("Errore in populateBulkAttachmentFilters:", error);
  }
}

function parseDownloadFileNameFromHeaders(response) {
  const contentDisposition = String(response.headers.get("content-disposition") || "");
  const utfMatch = contentDisposition.match(/filename\*=UTF-8''([^;]+)/i);
  if (utfMatch && utfMatch[1]) {
    return decodeURIComponent(utfMatch[1]).replace(/[\r\n"]/g, "");
  }

  const plainMatch = contentDisposition.match(/filename="?([^";]+)"?/i);
  if (plainMatch && plainMatch[1]) {
    return plainMatch[1].replace(/[\r\n"]/g, "");
  }

  return `mpl-attachments-${new Date().toISOString().replace(/[:.]/g, "-")}.zip`;
}

function getReadableFetchError(error) {
  const raw = String(error?.message || "").trim();
  if (!raw) {
    return "Errore durante il download allegati.";
  }

  const normalized = raw.toLowerCase();
  if (normalized.includes("failed to fetch") || normalized.includes("networkerror") || normalized.includes("load failed")) {
    return "Server non raggiungibile. Verifica che l'app sia avviata su http://localhost:3000.";
  }

  return raw;
}

async function downloadBulkAttachmentsZip() {
  if (!bulkDownloadAttachmentsBtnEl) {
    return;
  }

  bulkDownloadAttachmentsBtnEl.disabled = true;
  hideBulkExportProgress();
  setBulkDownloadStatus("Preparazione export allegati in corso...");

  try {
    const query = new URLSearchParams();
    const progressId =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `progress-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
    const packageFilter = String(bulkPackageFilterEl?.value || "").trim();
    const iflowFilter = String(bulkIflowFilterEl?.value || "").trim();
    const statusFilter = String(bulkStatusFilterEl?.value || "").trim().toUpperCase();
    const timeRangeFilter = String(bulkTimeFilterEl?.value || "").trim();
    const limitMplRaw = String(bulkLimitMplEl?.value || "").trim();

    query.set("progressId", progressId);

    if (packageFilter) {
      query.set("package", packageFilter);
    }

    if (iflowFilter) {
      query.set("iflow", iflowFilter);
    }

    if (statusFilter) {
      query.set("status", statusFilter);
    }

    if (timeRangeFilter) {
      query.set("timeRange", timeRangeFilter);
    }

    if (limitMplRaw) {
      query.set("limitMpl", limitMplRaw);
    }

    const url = `/api/cpi/attachments/export.zip${query.toString() ? `?${query.toString()}` : ""}`;
    startBulkExportProgressPolling(progressId);
    const response = await fetch(url);

    if (!response.ok) {
      const payload = await response.json().catch(async () => ({
        error: (await response.text()) || "Export allegati fallito"
      }));
      throw new Error(payload.error || "Export allegati fallito");
    }

    const blob = await response.blob();
    if (!blob || blob.size === 0) {
      throw new Error("ZIP vuoto: nessun contenuto scaricato.");
    }

    const fileName = parseDownloadFileNameFromHeaders(response);
    const blobUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = blobUrl;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(blobUrl);

    const megaBytes = (blob.size / (1024 * 1024)).toFixed(2);
    setBulkExportProgress(100, `100% - Download pronto (${megaBytes} MB)`);
    setBulkDownloadStatus(`Download completato: ${fileName} (${megaBytes} MB)`);
  } catch (error) {
    setBulkDownloadStatus(getReadableFetchError(error), true);
  } finally {
    stopBulkExportProgressPolling();
    bulkDownloadAttachmentsBtnEl.disabled = false;
  }
}

// Dashboard rendering
function renderStats(stats) {
  if (!statsGridEl) return;

  const interfacesTotal = Number(stats?.interfaces?.total || 0);
  const interfacesRunning = Number(stats?.interfaces?.running || 0);
  const messagesSuccess = Number(stats?.messages?.success || 0);
  const messagesFailed = Number(stats?.messages?.failed || 0);
  const messagesKnown = messagesSuccess + messagesFailed;

  const runningRatio = interfacesTotal > 0 ? Math.round((interfacesRunning / interfacesTotal) * 100) : 0;
  const failRatio = messagesKnown > 0 ? Math.round((messagesFailed / messagesKnown) * 100) : 0;
  
  const cards = [
    {
      label: "Interfacce Totali",
      value: interfacesTotal,
      meta: `${interfacesRunning} running`,
      tone: "neutral"
    },
    {
      label: "Disponibilita Interfacce",
      value: `${runningRatio}%`,
      meta: `${interfacesRunning}/${interfacesTotal} attive`,
      tone: runningRatio >= 90 ? "ok" : "warn"
    },
    {
      label: "Messaggi SUCCESS",
      value: messagesSuccess,
      meta: `${messagesKnown} con stato finale`,
      tone: "ok"
    },
    {
      label: "Messaggi FAILED",
      value: messagesFailed,
      meta: `${failRatio}% di errore`,
      tone: messagesFailed > 0 ? "danger" : "neutral"
    }
  ];

  statsGridEl.innerHTML = cards
    .map(
      (card) => `
        <article class="stat stat-${card.tone}">
          <span class="stat-label">${card.label}</span>
          <strong class="stat-value">${card.value}</strong>
          <small class="stat-meta">${card.meta}</small>
        </article>
      `
    )
    .join("");
}

function renderInterfacesBySystem() {
  if (!interfacesBySystemEl) return;
  
  const bySystem = {};
  
  overviewCache.interfaces.forEach((item) => {
    const system = getSystemForInterface(item);
    if (!bySystem[system]) {
      bySystem[system] = { total: 0, running: 0, stopped: 0, error: 0 };
    }
    bySystem[system].total++;
    if (item.status === "Running") bySystem[system].running++;
    else if (item.status === "Stopped") bySystem[system].stopped++;
    else if (item.status === "Error") bySystem[system].error++;
  });
  
  const systems = Object.keys(bySystem).sort((a, b) => {
    const riskA = (bySystem[a].error || 0) - (bySystem[a].running || 0);
    const riskB = (bySystem[b].error || 0) - (bySystem[b].running || 0);
    if (riskA !== riskB) {
      return riskB - riskA;
    }

    return a.localeCompare(b);
  });
  
  if (systems.length === 0) {
    interfacesBySystemEl.innerHTML = '<p class="muted">Nessuna interfaccia disponibile</p>';
    return;
  }
  
  interfacesBySystemEl.innerHTML = `
    <div class="system-grid system-grid-dashboard">
      ${systems.map((sys) => `
        <article class="system-card ${bySystem[sys].error > 0 ? "system-card-alert" : ""}">
          <h3>${sys}</h3>
          <div class="system-health-meter" aria-hidden="true">
            <span style="width: ${Math.max(6, Math.round((bySystem[sys].running / Math.max(bySystem[sys].total, 1)) * 100))}%"></span>
          </div>
          <div class="system-stats">
            <span>Totali: <strong>${bySystem[sys].total}</strong></span>
            <span class="running">Running: <strong>${bySystem[sys].running}</strong></span>
            <span>Stopped: <strong>${bySystem[sys].stopped}</strong></span>
            ${bySystem[sys].error > 0 ? `<span class="error-text">Error: <strong>${bySystem[sys].error}</strong></span>` : ''}
            <span class="muted">Health: <strong>${Math.round((bySystem[sys].running / Math.max(bySystem[sys].total, 1)) * 100)}%</strong></span>
          </div>
        </article>
      `).join("")}
    </div>
  `;
}

function renderRecentMessages() {
  if (!recentMessagesBodyEl) return;
  
  const recent = overviewCache.messages.slice(0, 20);
  
  if (recent.length === 0) {
    recentMessagesBodyEl.innerHTML = "<tr><td colspan='5' class='muted'>Nessun messaggio trovato</td></tr>";
    return;
  }
  
  recentMessagesBodyEl.innerHTML = recent
    .map(
      (item) => `
        <tr>
          <td class="flow-compact">${formatFlowCompact(item.integrationFlow)}</td>
          <td>${formatMplLink(item)}</td>
          <td><span class="badge ${badgeClass(item.status)}">${item.status}</span></td>
          <td class="custom-headers">${formatCustomHeaders(item.customHeaders)}</td>
          <td class="attachments-cell">${formatAttachmentsCell(item)}</td>
        </tr>
      `
    )
    .join("");
}

// Interfaces page rendering
function renderInterfaces() {
  if (!interfacesBodyEl) return;
  
  const systemFilter = (interfaceSystemFilterEl?.value || "").trim();
  
  let filtered = overviewCache.interfaces;
  
  if (systemFilter) {
    filtered = filtered.filter((item) => getSystemForInterface(item) === systemFilter);
  }

  if (filtered.length === 0) {
    interfacesBodyEl.innerHTML = "<p class='muted' style='padding: 16px'>Nessuna interfaccia trovata</p>";
    return;
  }

  // Group by system/package
  const bySystem = {};
  filtered.forEach((item) => {
    const system = getSystemForInterface(item);
    if (!bySystem[system]) {
      bySystem[system] = [];
    }
    bySystem[system].push(item);
  });
  
  const systems = Object.keys(bySystem).sort();
  
  interfacesBodyEl.innerHTML = systems
    .map((system) => `
      <div class="system-section">
        <h3 class="system-section-header">${system}</h3>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Nome</th>
                <th>ID</th>
                <th>Versione</th>
                <th>Stato</th>
              </tr>
            </thead>
            <tbody>
              ${bySystem[system]
                .map(
                  (item) => `
                <tr>
                  <td><a href="#" class="interface-link" data-action="open-interface-messages" data-interface-id="${escapeHtml(item.id)}" data-interface-name="${escapeHtml(item.name)}">${item.name}</a></td>
                  <td><a href="#" class="system-badge interface-link" data-action="open-interface-messages" data-interface-id="${escapeHtml(item.id)}" data-interface-name="${escapeHtml(item.name)}">${item.id}</a></td>
                  <td>${item.version}</td>
                  <td><span class="badge ${badgeClass(item.status)}">${item.status}</span></td>
                </tr>
              `
                )
                .join("")}
            </tbody>
          </table>
        </div>
      </div>
    `)
    .join("");
}

// Messages page rendering
function renderMessages() {
  if (!messagesBodyEl) return;
  
  const systemFilter = (messageSystemFilterEl?.value || "").trim();
  const flowFilter = (messageFlowFilterEl?.value || "").trim().toLowerCase();
  const statusFilter = messageStatusFilterEl?.value || "";
  const timeFilter = messageTimeFilterEl?.value || "";
  const headerFilter = (messageHeaderFilterEl?.value || "").trim().toLowerCase();
  
  let filtered = overviewCache.messages.slice();
  
  if (systemFilter) {
    filtered = filtered.filter((item) => getSystemForMessage(item) === systemFilter);
  }

  if (flowFilter) {
    filtered = filtered.filter((item) => String(item.integrationFlow || "").toLowerCase().includes(flowFilter));
  }
  
  if (statusFilter) {
    filtered = filtered.filter((item) => item.status === statusFilter);
  }

  if (activeInterfaceMessageFilter) {
    const name = String(activeInterfaceMessageFilter.name || "");
    if (!messagesScopedToActiveInterface) {
      filtered = filtered.filter((item) => {
        const flow = String(item.integrationFlow || "");
        return flow === name;
      });
    }
  }

  if (timeFilter) {
    const threshold = getTimeThreshold(timeFilter);
    if (threshold !== null) {
      filtered = filtered.filter((item) => {
        const ts = getMessageTimestamp(item);
        return ts !== null && ts >= threshold;
      });
    }
  }

  if (headerFilter) {
    filtered = filtered.filter((item) => {
      const headers = Array.isArray(item.customHeaders) ? item.customHeaders : [];
      return headers.some((header) => {
        const name = String(header?.name || "").toLowerCase();
        const value = String(header?.value || "").toLowerCase();
        return name.includes(headerFilter) || value.includes(headerFilter);
      });
    });
  }

  if (filtered.length === 0) {
    messagesBodyEl.innerHTML = "<tr><td colspan='6'>Nessun messaggio trovato</td></tr>";
    return;
  }

  messagesBodyEl.innerHTML = filtered
    .map(
      (item) => {
        const timestamp = getMessageTimestamp(item);
        const formattedTimestamp = timestamp ? formatDate(new Date(timestamp).toISOString()) : "-";
        return `
        <tr>
          <td class="timestamp-cell">${formattedTimestamp}</td>
          <td><span class="system-badge">${getSystemForMessage(item)}</span></td>
          <td class="flow-compact">${formatFlowCompact(item.integrationFlow)}</td>
          <td>${formatMplLink(item)}</td>
          <td><span class="badge ${badgeClass(item.status)}">${item.status}</span></td>
          <td class="custom-headers">${formatCustomHeaders(item.customHeaders)}</td>
          <td class="attachments-cell">${formatAttachmentsCell(item)}</td>
        </tr>
      `;
      }
    )
    .join("");
}

async function fetchMessageAttachments(mplId) {
  const response = await fetch(`/api/cpi/messages/${encodeURIComponent(mplId)}/attachments`);
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || "Errore nel caricamento allegati");
  }

  return response.json();
}

function showAttachmentsListInViewer(mplId, attachments, diagnostics = null) {
  if (!attachmentViewerEl || !attachmentViewerBodyEl || !attachmentViewerMetaEl) {
    return;
  }

  attachmentViewerEl.classList.remove("hidden");
  attachmentViewerMetaEl.textContent = `MPL ${mplId} - allegati`;

  if (!attachments || attachments.length === 0) {
    const diagLabel = formatAttachmentDiagnostics(diagnostics);
    attachmentViewerBodyEl.innerHTML = `
      <p class='muted'>Nessun allegato disponibile per questo messaggio.</p>
      ${diagLabel ? `<p class='muted compact'>Diagnostica MPL: ${escapeHtml(diagLabel)}</p>` : ""}
    `;
    return;
  }

  attachmentViewerBodyEl.innerHTML = attachments
    .map((att) => {
      const name = escapeHtml(att.name || "attachment");
      const size = formatAttachmentSize(att.payloadSize);
      const meta = [size, att.contentType].filter(Boolean).join(" - ");
      const downloadUrl = escapeHtml(att.downloadUrl || "");
      if (!downloadUrl) {
        return `<span class="attachment-item"><span>${name}</span>${meta ? `<small>${escapeHtml(meta)}</small>` : ""}</span>`;
      }

      return `<a class="attachment-item" href="${downloadUrl}" data-attachment-url="${downloadUrl}" data-attachment-name="${name}">${name}${meta ? `<small>${escapeHtml(meta)}</small>` : ""}</a>`;
    })
    .join("");
}

function updateMessageAttachmentsInCache(mplId, attachments) {
  if (!mplId) {
    return;
  }

  const patch = (collection) => {
    collection.forEach((msg) => {
      if (String(msg.mplId || msg.id || "") === String(mplId)) {
        msg.attachments = attachments;
        msg.attachmentsLoaded = true;
      }
    });
  };

  patch(overviewCache.messages || []);
}

function updateMessageAttachmentDiagnosticsInCache(mplId, diagnostics) {
  if (!mplId || !diagnostics) {
    return;
  }

  (overviewCache.messages || []).forEach((msg) => {
    if (String(msg.mplId || msg.id || "") === String(mplId)) {
      msg.attachmentsDiagnostics = diagnostics;
    }
  });
}

async function loadAttachmentsForMessage(mplId, silent = false) {
  if (!mplId || attachmentsLoading.has(mplId)) {
    return;
  }

  attachmentsLoading.add(mplId);
  renderCurrentPage();

  try {
    const data = await fetchMessageAttachments(mplId);
    const items = Array.isArray(data.items) ? data.items : [];
    const diagnostics = data.diagnostics && typeof data.diagnostics === "object" ? data.diagnostics : null;
    attachmentsByMplId.set(mplId, items);
    if (diagnostics) {
      attachmentDiagnosticsByMplId.set(mplId, diagnostics);
      updateMessageAttachmentDiagnosticsInCache(mplId, diagnostics);
    }
    updateMessageAttachmentsInCache(mplId, items);
    return items;
  } catch (error) {
    if (!silent) {
      setError(error.message);
    }
    throw error;
  } finally {
    attachmentsLoading.delete(mplId);
    renderCurrentPage();
  }
}

async function openAttachmentsForMessage(mplId) {
  if (!mplId) {
    return;
  }

  openAttachmentViewerLoading(`MPL ${mplId}`);

  try {
    const hasCachedAttachments = attachmentsByMplId.has(mplId);
    const attachments = hasCachedAttachments
      ? attachmentsByMplId.get(mplId)
      : await loadAttachmentsForMessage(mplId, true);
    const diagnostics = attachmentDiagnosticsByMplId.get(mplId) || null;

    if (Array.isArray(attachments) && attachments.length === 1 && attachments[0].downloadUrl) {
      return openAttachmentViewer(attachments[0].downloadUrl, attachments[0].name || "allegato");
    }

    showAttachmentsListInViewer(mplId, attachments || [], diagnostics);
  } catch (error) {
    if (!attachmentViewerBodyEl || !attachmentViewerMetaEl || !attachmentViewerEl) {
      return;
    }

    attachmentViewerMetaEl.textContent = `MPL ${mplId}`;
    attachmentViewerBodyEl.innerHTML = `<p class='error-inline'>${escapeHtml(error.message)}</p>`;
    attachmentViewerEl.classList.remove("hidden");
  }
}

// Config page rendering
function renderConnectionStatus() {
  if (!connectionStatusEl) return;
  
  fetch("/api/config")
    .then((res) => res.json())
    .then((data) => {
      if (data.configured) {
        connectionStatusEl.innerHTML = `
          <div class="connection-info">
            <p><strong>Base URL:</strong> ${data.config.baseUrl}</p>
            <p><strong>Auth Type:</strong> ${data.config.authType}</p>
            <p><strong>Stato:</strong> <span class="badge success">Connesso</span></p>
          </div>
        `;
      } else {
        connectionStatusEl.innerHTML = `
          <p class="muted">Nessuna configurazione attiva. Carica una service key nella sezione sopra.</p>
        `;
      }
    })
    .catch(() => {
      connectionStatusEl.innerHTML = `
        <p class="error-inline">Impossibile verificare lo stato di connessione.</p>
      `;
    });
}

// Render current page
function renderCurrentPage() {
  switch (currentPage) {
    case "dashboard":
      renderStats(overviewCache.stats);
      renderInterfacesBySystem();
      renderRecentMessages();
      break;
    case "interfaces":
      renderInterfaces();
      break;
    case "messages":
      updateMessageFlowsForSystem();
      renderMessages();
      break;
    case "config":
      renderConnectionStatus();
      refreshMessageCacheStatus();
      break;
  }
}

// API calls
async function fetchOverview() {
  setError("");

  const response = await fetch("/api/cpi/overview");
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || "Errore nel caricamento dashboard");
  }

  return response.json();
}

async function fetchMessages(top = 2000, options = {}) {
  const query = new URLSearchParams();
  query.set("top", String(top));

  const interfaceName = String(options.interfaceName || "").trim();
  const timeRange = String(options.timeRange || "").trim();

  if (interfaceName) {
    query.set("interfaceName", interfaceName);
  }

  if (timeRange) {
    query.set("timeRange", timeRange);
  }

  const response = await fetch(`/api/cpi/messages?${query.toString()}`);
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || "Errore nel caricamento messaggi");
  }

  return response.json();
}

async function fetchMessageCacheStatus() {
  const response = await fetch("/api/cache/messages/status");
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || "Errore nel caricamento stato cache");
  }

  return response.json();
}

async function loadCachedSystemsIndex() {
  try {
    const data = await fetchCachedSystems();
    overviewCache.systems = data.systems || [];
    overviewCache.flows = data.flows || {};
    overviewCache.allFlows = data.allFlows || [];
  } catch (error) {
    console.log("Errore nel caricamento indice sistemi:", error);
    // Usa valori di default se fallisce
    overviewCache.systems = [];
    overviewCache.flows = {};
    overviewCache.allFlows = [];
  }
}

async function fetchCachedMessages(limit = 0) {
  const query = new URLSearchParams();
  if (limit > 0) {
    query.set("limit", String(limit));
  }
  query.set("includeUnknown", "true");
  const suffix = query.toString();
  const response = await fetch(`/api/cache/messages${suffix ? `?${suffix}` : ""}`);
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || "Errore nel caricamento messaggi da cache");
  }

  return response.json();
}

async function fetchCachedSystems() {
  const response = await fetch("/api/cache/systems");
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || "Errore nel caricamento sistemi da cache");
  }

  return response.json();
}

async function refreshMessageCacheStatus() {
  try {
    const data = await fetchMessageCacheStatus();
    setMessageCacheStatus(formatCacheStatus(data.meta, data.inProgress), Boolean(data.meta?.lastSyncError));
    return data;
  } catch (error) {
    setMessageCacheStatus(error.message, true);
    return null;
  }
}

function stopCacheStatusPolling() {
  if (cacheStatusPollTimerId) {
    clearInterval(cacheStatusPollTimerId);
    cacheStatusPollTimerId = null;
  }
}

function startCacheStatusPolling() {
  stopCacheStatusPolling();
  cacheStatusPollTimerId = setInterval(async () => {
    const status = await refreshMessageCacheStatus();
    if (!status || !status.inProgress) {
      stopCacheStatusPolling();
      if (currentPage === "messages") {
        loadMessagesForPage(true);
      }
    }
  }, 3000);
}

async function startMessageCacheSync(force = true) {
  if (!syncMessageCacheBtnEl) {
    return;
  }

  syncMessageCacheBtnEl.disabled = true;
  setMessageCacheStatus("Sincronizzazione cache in avvio...");

  try {
    const limitRaw = String(syncMessageCacheLimitEl?.value || "").trim();
    const limitValue = Number(limitRaw);
    const hasLimit = limitRaw !== "" && !Number.isNaN(limitValue) && limitValue > 0;

    const response = await fetch(`/api/cache/messages/sync?force=${force ? "true" : "false"}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        force,
        ...(hasLimit ? { maxItems: Math.floor(limitValue) } : {})
      })
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.error || "Impossibile avviare la sincronizzazione cache");
    }

    await refreshMessageCacheStatus();
    startCacheStatusPolling();
  } catch (error) {
    setMessageCacheStatus(error.message, true);
  } finally {
    syncMessageCacheBtnEl.disabled = false;
  }
}

async function loadInterfacesForPage(force = false) {
  if (isInterfacesPageLoading || (interfacesPageLoaded && !force)) {
    return;
  }

  isInterfacesPageLoading = true;
  try {
    // Ricarica le interfacce complete dal backend
    const data = await fetchOverview();
    overviewCache.interfaces = data.interfaces || [];
    
    interfacesPageLoaded = true;
    populateSystemFilters();
    if (currentPage === "interfaces") {
      renderInterfaces();
    }
  } catch (error) {
    setError(error.message);
  } finally {
    isInterfacesPageLoading = false;
  }
}

async function loadMessagesForPage(force = false, interfaceFilter = null) {
  const hasInterfaceFilter = Boolean(interfaceFilter?.id || interfaceFilter?.name);
  if (isMessagesPageLoading || (messagesPageLoaded && !force && !hasInterfaceFilter)) {
    return;
  }

  isMessagesPageLoading = true;
  try {
    if (hasInterfaceFilter) {
      const activeTimeRange = String(messageTimeFilterEl?.value || "").trim();
      const live = await fetchMessages(3000, {
        interfaceName: interfaceFilter.name || "",
        timeRange: activeTimeRange
      });
      overviewCache.messages = live.items || [];
      messagesScopedToActiveInterface = true;
    } else {
      // Carica la cache completa per estrarre tutti i sistemi e flow disponibili
      const cached = await fetchCachedMessages(0);
      if (Array.isArray(cached.items) && cached.items.length > 0) {
        overviewCache.messages = cached.items;
      } else {
        const live = await fetchMessages(2000);
        overviewCache.messages = live.items || [];
      }
      messagesScopedToActiveInterface = false;
    }

    messagesPageLoaded = true;
    
    // Carica l'indice completo dei sistemi/flows (se non ancora caricato)
    if (!overviewCache.systems || overviewCache.systems.length === 0) {
      await loadCachedSystemsIndex();
    }
    
    populateSystemFilters();
    updateMessageFlowsForSystem();
    populateBulkAttachmentFilters();
    if (currentPage === "messages") {
      renderMessages();
    }
  } catch (error) {
    setError(error.message);
  } finally {
    isMessagesPageLoading = false;
  }
}

function openMessagesForInterface(interfaceId, interfaceName) {
  const name = String(interfaceName || "").trim();
  if (!name) {
    return;
  }

  setActiveInterfaceMessageFilter({
    id: "",
    name,
    label: name
  });

  if (messageSystemFilterEl) {
    messageSystemFilterEl.value = "";
  }

  if (messageFlowFilterEl) {
    messageFlowFilterEl.value = "";
  }

  if (messageStatusFilterEl) {
    messageStatusFilterEl.value = "";
  }

  if (messageTimeFilterEl) {
    messageTimeFilterEl.value = "7d";
  }

  showPage("messages");
  loadMessagesForPage(true, { name });
}

async function loadConfigStatus() {
  try {
    const response = await fetch("/api/config");
    if (!response.ok) {
      return;
    }

    const data = await response.json();
    if (data.configured) {
      setConfigStatus(`Configurazione attiva (${data.config.authType})`);
    } else {
      setConfigStatus("Nessuna configurazione CPI attiva. Carica una service key.");
    }
  } catch (_error) {
    // Keep UI usable even if status endpoint is unavailable.
  }
}

async function applyServiceKey() {
  const raw = (serviceKeyJsonEl.value || "").trim();
  if (!raw) {
    setConfigStatus("Incolla il JSON della service key prima di applicare.", true);
    return;
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (_error) {
    setConfigStatus("JSON non valido. Controlla la sintassi.", true);
    return;
  }

  applyServiceKeyBtnEl.disabled = true;
  setConfigStatus("Applicazione service key in corso...");

  try {
    const response = await fetch("/api/config/service-key", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error || "Errore durante il caricamento della service key");
    }

    setConfigStatus("Service key applicata. Connessione CPI aggiornata.");
    renderConnectionStatus();
    await refresh();
  } catch (error) {
    setConfigStatus(error.message, true);
  } finally {
    applyServiceKeyBtnEl.disabled = false;
  }
}

async function readServiceKeyFromFile() {
  const [file] = serviceKeyFileEl.files || [];
  if (!file) {
    return;
  }

  try {
    const text = await file.text();
    serviceKeyJsonEl.value = text;
    setConfigStatus("File caricato. Premi 'Applica service key'.");
  } catch (_error) {
    setConfigStatus("Impossibile leggere il file JSON selezionato.", true);
  }
}

async function refresh() {
  if (!refreshBtnEl) return;
  
  refreshBtnEl.disabled = true;

  try {
    const data = await fetchOverview();
    overviewCache = {
      stats: data.stats,
      interfaces: data.interfaces || [],
      messages: data.messages || []
    };

    // Reset so Messages page reloads a wider dataset when opened.
    messagesPageLoaded = false;

    populateSystemFilters();
    populateBulkAttachmentFilters();
    renderCurrentPage();

    if (currentPage === "messages") {
      loadMessagesForPage(true);
    }
    
    if (lastUpdateEl) {
      lastUpdateEl.textContent = `Ultimo aggiornamento: ${formatDate(data.timestamp)}`;
    }
  } catch (error) {
    setError(error.message);
  } finally {
    refreshBtnEl.disabled = false;
  }
}

function armAutoRefresh() {
  if (timerId) {
    clearInterval(timerId);
    timerId = null;
  }

  if (autoRefreshEl && autoRefreshEl.checked) {
    timerId = setInterval(refresh, 30000);
  }
}

// Event Listeners
if (refreshBtnEl) refreshBtnEl.addEventListener("click", refresh);
if (autoRefreshEl) autoRefreshEl.addEventListener("change", armAutoRefresh);
if (serviceKeyFileEl) serviceKeyFileEl.addEventListener("change", readServiceKeyFromFile);
if (applyServiceKeyBtnEl) applyServiceKeyBtnEl.addEventListener("click", applyServiceKey);

if (interfaceSystemFilterEl) interfaceSystemFilterEl.addEventListener("change", renderInterfaces);
if (interfaceSystemFilterEl) interfaceSystemFilterEl.addEventListener("input", renderInterfaces);

// Quando cambia il sistema dei messaggi, aggiorna i flow disponibili
if (messageSystemFilterEl) {
  messageSystemFilterEl.addEventListener("change", () => {
    updateMessageFlowsForSystem();
    renderMessages();
  });
  messageSystemFilterEl.addEventListener("input", () => {
    updateMessageFlowsForSystem();
    renderMessages();
  });
}

if (messageFlowFilterEl) messageFlowFilterEl.addEventListener("change", renderMessages);
if (messageFlowFilterEl) messageFlowFilterEl.addEventListener("input", renderMessages);
if (messageStatusFilterEl) messageStatusFilterEl.addEventListener("change", renderMessages);
if (messageTimeFilterEl) messageTimeFilterEl.addEventListener("change", renderMessages);
if (messageHeaderFilterEl) {
  messageHeaderFilterEl.addEventListener("change", renderMessages);
  messageHeaderFilterEl.addEventListener("input", renderMessages);
}
if (syncMessageCacheBtnEl) syncMessageCacheBtnEl.addEventListener("click", () => startMessageCacheSync(true));
if (refreshMessageCacheStatusBtnEl) refreshMessageCacheStatusBtnEl.addEventListener("click", refreshMessageCacheStatus);
if (bulkDownloadAttachmentsBtnEl) bulkDownloadAttachmentsBtnEl.addEventListener("click", downloadBulkAttachmentsZip);
if (bulkPackageFilterEl) {
  bulkPackageFilterEl.addEventListener("change", populateBulkAttachmentFilters);
  bulkPackageFilterEl.addEventListener("input", populateBulkAttachmentFilters);
}
if (closeAttachmentViewerBtnEl) closeAttachmentViewerBtnEl.addEventListener("click", closeAttachmentViewer);
if (clearMessageInterfaceFilterBtnEl) {
  clearMessageInterfaceFilterBtnEl.addEventListener("click", () => {
    setActiveInterfaceMessageFilter(null);
    loadMessagesForPage(true);
  });
}
if (attachmentViewerEl) {
  attachmentViewerEl.addEventListener("click", (event) => {
    const target = event.target;
    if (target instanceof HTMLElement && target.dataset.action === "close-attachment-viewer") {
      closeAttachmentViewer();
    }
  });
}
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeAttachmentViewer();
  }
});
if (messagesBodyEl) {
  messagesBodyEl.addEventListener("click", (event) => {
    const listLink = event.target.closest("a[data-action='open-attachments']");
    if (listLink) {
      event.preventDefault();
      const mplId = listLink.getAttribute("data-mpl-id") || "";
      openAttachmentsForMessage(mplId);
      return;
    }

    const target = event.target.closest("a[data-attachment-url]");
    if (!target) {
      return;
    }

    event.preventDefault();
    const url = target.getAttribute("data-attachment-url") || target.getAttribute("href") || "";
    const name = target.getAttribute("data-attachment-name") || "";
    openAttachmentViewer(url, name);
  });
}
if (interfacesBodyEl) {
  interfacesBodyEl.addEventListener("click", (event) => {
    const target = event.target.closest("[data-action='open-interface-messages']");
    if (!target) {
      return;
    }

    event.preventDefault();
    const interfaceId = target.getAttribute("data-interface-id") || "";
    const interfaceName = target.getAttribute("data-interface-name") || "";
    openMessagesForInterface(interfaceId, interfaceName);
  });
}
if (recentMessagesBodyEl) {
  recentMessagesBodyEl.addEventListener("click", (event) => {
    const listLink = event.target.closest("a[data-action='open-attachments']");
    if (listLink) {
      event.preventDefault();
      const mplId = listLink.getAttribute("data-mpl-id") || "";
      openAttachmentsForMessage(mplId);
      return;
    }

    const target = event.target.closest("a[data-attachment-url]");
    if (!target) {
      return;
    }

    event.preventDefault();
    const url = target.getAttribute("data-attachment-url") || target.getAttribute("href") || "";
    const name = target.getAttribute("data-attachment-name") || "";
    openAttachmentViewer(url, name);
  });
}
if (attachmentViewerBodyEl) {
  attachmentViewerBodyEl.addEventListener("click", (event) => {
    const target = event.target.closest("a[data-attachment-url]");
    if (!target) {
      return;
    }

    event.preventDefault();
    const url = target.getAttribute("data-attachment-url") || target.getAttribute("href") || "";
    const name = target.getAttribute("data-attachment-name") || "";
    openAttachmentViewer(url, name);
  });
}

// Initialize
initNavigation();
loadCachedSystemsIndex();
refresh();
armAutoRefresh();
loadConfigStatus();
refreshMessageCacheStatus();
