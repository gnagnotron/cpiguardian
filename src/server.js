const express = require("express");
const morgan = require("morgan");
const path = require("path");
const fs = require("fs");
const archiverModule = require("archiver");
const dotenv = require("dotenv");

function createZipArchive(options = {}) {
  if (typeof archiverModule === "function") {
    return archiverModule("zip", options);
  }

  if (archiverModule && typeof archiverModule.create === "function") {
    return archiverModule.create("zip", options);
  }

  if (archiverModule && typeof archiverModule.ZipArchive === "function") {
    return new archiverModule.ZipArchive(options);
  }

  throw new Error("Modulo archiver non supportato in questo runtime.");
}

dotenv.config();

const app = express();
const port = Number(process.env.PORT || 3000);
const messagesTop = Number(process.env.CPI_MESSAGES_TOP || 100);
const cacheWindowDays = Number(process.env.CPI_CACHE_WINDOW_DAYS || 30);
const cachePageSize = Number(process.env.CPI_CACHE_PAGE_SIZE || 500);
const cacheMaxPages = Number(process.env.CPI_CACHE_MAX_PAGES || 0);
const cacheMaxItems = Number(process.env.CPI_CACHE_MAX_ITEMS || 0);
const cacheApiDefaultLimit = Number(process.env.CPI_CACHE_API_DEFAULT_LIMIT || 3000);
const preloadAttachmentsEnabled = String(process.env.CPI_PRELOAD_ATTACHMENTS || "false").toLowerCase() === "true";
const attachmentPrefetchLimit = Number(process.env.CPI_ATTACHMENT_PREFETCH_LIMIT || 1500);
const cacheDir = path.join(__dirname, "..", "data");
const cacheFilePath = path.join(cacheDir, "messages-cache.json");

const runtimeConfig = {
  baseUrl: "",
  authType: (process.env.CPI_AUTH_TYPE || "basic").toLowerCase(),
  username: process.env.CPI_USERNAME || "",
  password: process.env.CPI_PASSWORD || "",
  tokenUrl: process.env.CPI_TOKEN_URL || "",
  clientId: process.env.CPI_CLIENT_ID || "",
  clientSecret: process.env.CPI_CLIENT_SECRET || "",
  oauthScope: process.env.CPI_OAUTH_SCOPE || ""
};

let oauthTokenCache = {
  token: null,
  expiresAt: 0
};

const interfacePackageLookupCache = {
  lookup: new Map(),
  expiresAt: 0,
  inFlight: null
};

function resetInterfacePackageLookupCache() {
  interfacePackageLookupCache.lookup = new Map();
  interfacePackageLookupCache.expiresAt = 0;
  interfacePackageLookupCache.inFlight = null;
}

const attachmentExportProgress = new Map();

const messageCacheState = {
  items: [],
  meta: {
    windowDays: cacheWindowDays,
    count: 0,
    downloadedAllAvailable: false,
    oldestLogAt: null,
    newestLogAt: null,
    cutoffAt: null,
    lastSyncStartedAt: null,
    lastSyncCompletedAt: null,
    lastSyncError: null,
    pagesFetched: 0,
    rawFetched: 0,
    attachmentsPrefetchEnabled: preloadAttachmentsEnabled,
    attachmentsPrefetchLimit: attachmentPrefetchLimit,
    attachmentsProcessed: 0,
    attachmentsWithItems: 0,
    attachmentsFullyScanned: false,
    maxItems: cacheMaxItems,
    requestedMaxItems: cacheMaxItems,
    estimatedTotalAvailable: null,
    targetDownloadCount: null,
    progressPercent: null,
    truncated: false,
    sourceBaseUrl: null
  },
  sync: {
    inProgress: false
  }
};

function parseLogTimestamp(value) {
  if (!value) {
    return null;
  }

  const raw = String(value);
  const odataMatch = raw.match(/\/Date\((\d+)(?:[+-]\d+)?\)\//);
  if (odataMatch) {
    const millis = Number(odataMatch[1]);
    return Number.isNaN(millis) ? null : millis;
  }

  const ts = new Date(raw).getTime();
  if (!Number.isNaN(ts)) {
    return ts;
  }

  const utcTs = new Date(`${raw}Z`).getTime();
  return Number.isNaN(utcTs) ? null : utcTs;
}

function getMessageLogTimestamp(item) {
  return parseLogTimestamp(item.logEnd || item.logStart);
}

function getTimeThresholdMs(range) {
  const now = Date.now();
  switch (String(range || "").trim()) {
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

function refreshCacheTimeBounds() {
  let oldest = null;
  let newest = null;

  messageCacheState.items.forEach((item) => {
    const ts = getMessageLogTimestamp(item);
    if (ts === null) {
      return;
    }

    if (oldest === null || ts < oldest) {
      oldest = ts;
    }

    if (newest === null || ts > newest) {
      newest = ts;
    }
  });

  messageCacheState.meta.count = messageCacheState.items.length;
  messageCacheState.meta.oldestLogAt = oldest ? new Date(oldest).toISOString() : null;
  messageCacheState.meta.newestLogAt = newest ? new Date(newest).toISOString() : null;
}

function resetMessageCache(sourceBaseUrl = null) {
  messageCacheState.items = [];
  messageCacheState.meta.count = 0;
  messageCacheState.meta.downloadedAllAvailable = false;
  messageCacheState.meta.oldestLogAt = null;
  messageCacheState.meta.newestLogAt = null;
  messageCacheState.meta.pagesFetched = 0;
  messageCacheState.meta.rawFetched = 0;
  messageCacheState.meta.attachmentsProcessed = 0;
  messageCacheState.meta.attachmentsWithItems = 0;
  messageCacheState.meta.attachmentsFullyScanned = false;
  messageCacheState.meta.requestedMaxItems = cacheMaxItems;
  messageCacheState.meta.estimatedTotalAvailable = null;
  messageCacheState.meta.targetDownloadCount = null;
  messageCacheState.meta.progressPercent = null;
  messageCacheState.meta.truncated = false;
  messageCacheState.meta.sourceBaseUrl = sourceBaseUrl;
}

function saveCacheToDisk() {
  if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true });
  }

  const payload = {
    items: messageCacheState.items,
    meta: messageCacheState.meta
  };

  fs.writeFileSync(cacheFilePath, JSON.stringify(payload), "utf8");
}

function loadCacheFromDisk() {
  if (!fs.existsSync(cacheFilePath)) {
    return;
  }

  try {
    const raw = fs.readFileSync(cacheFilePath, "utf8");
    const parsed = JSON.parse(raw);

    const loadedItems = Array.isArray(parsed.items) ? parsed.items : [];
    const loadedSourceBaseUrl = normalizeBaseUrl(parsed?.meta?.sourceBaseUrl || "");
    const currentSourceBaseUrl = normalizeBaseUrl(runtimeConfig.baseUrl || "");

    // Drop stale cache if source tenant differs (or legacy cache without source marker).
    if (
      loadedItems.length > 0 &&
      currentSourceBaseUrl &&
      (!loadedSourceBaseUrl || loadedSourceBaseUrl !== currentSourceBaseUrl)
    ) {
      resetMessageCache(currentSourceBaseUrl);
      saveCacheToDisk();
      return;
    }

    const safeMaxItems = Number.isNaN(cacheMaxItems) || cacheMaxItems <= 0 ? loadedItems.length : cacheMaxItems;
    messageCacheState.items = loadedItems.slice(0, safeMaxItems);
    if (parsed.meta && typeof parsed.meta === "object") {
      messageCacheState.meta = {
        ...messageCacheState.meta,
        ...parsed.meta,
        windowDays: cacheWindowDays
      };
    }

    messageCacheState.meta.maxItems = cacheMaxItems;
    messageCacheState.meta.truncated = loadedItems.length > messageCacheState.items.length;
    messageCacheState.meta.sourceBaseUrl = loadedSourceBaseUrl || currentSourceBaseUrl || null;

    refreshCacheTimeBounds();
  } catch (error) {
    console.warn(`Cache messaggi non caricata: ${error.message}`);
  }
}

async function syncMessagesCache({ force = false, maxItemsOverride = null } = {}) {
  if (messageCacheState.sync.inProgress) {
    return false;
  }

  const now = Date.now();
  const cutoffTs = now - cacheWindowDays * 24 * 60 * 60 * 1000;
  const cutoffIso = new Date(cutoffTs).toISOString();

  if (!force && messageCacheState.meta.lastSyncCompletedAt) {
    const lastSyncTs = new Date(messageCacheState.meta.lastSyncCompletedAt).getTime();
    if (!Number.isNaN(lastSyncTs) && now - lastSyncTs < 5 * 60 * 1000) {
      return false;
    }
  }

  const safeConfiguredMaxItems = Number.isNaN(cacheMaxItems) || cacheMaxItems <= 0 ? Number.MAX_SAFE_INTEGER : cacheMaxItems;
  const safeOverrideMaxItems =
    Number.isNaN(Number(maxItemsOverride)) || Number(maxItemsOverride) <= 0
      ? Number.MAX_SAFE_INTEGER
      : Math.min(Number(maxItemsOverride), Number.MAX_SAFE_INTEGER);
  const safeMaxItems = Math.min(safeConfiguredMaxItems, safeOverrideMaxItems);

  messageCacheState.sync.inProgress = true;
  messageCacheState.meta.sourceBaseUrl = normalizeBaseUrl(runtimeConfig.baseUrl || "") || null;
  messageCacheState.meta.lastSyncStartedAt = new Date(now).toISOString();
  messageCacheState.meta.lastSyncError = null;
  messageCacheState.meta.cutoffAt = cutoffIso;
  messageCacheState.meta.pagesFetched = 0;
  messageCacheState.meta.rawFetched = 0;
  messageCacheState.meta.attachmentsProcessed = 0;
  messageCacheState.meta.attachmentsWithItems = 0;
  messageCacheState.meta.attachmentsFullyScanned = false;
  messageCacheState.meta.requestedMaxItems = Number.isFinite(safeMaxItems) ? safeMaxItems : cacheMaxItems;
  messageCacheState.meta.estimatedTotalAvailable = null;
  messageCacheState.meta.targetDownloadCount = null;
  messageCacheState.meta.progressPercent = 0;

  try {
    const safeMaxPages = Number.isNaN(cacheMaxPages) || cacheMaxPages <= 0 ? Number.MAX_SAFE_INTEGER : cacheMaxPages;
    const interfacesPayload = await cpiGet("api/v1/IntegrationRuntimeArtifacts", {
      $format: "json"
    });
    const interfaces = mapInterfaces(normalizeCpiCollection(interfacesPayload));
    const runtimePackageLookup = buildRuntimePackageLookup(interfaces);

    const byId = new Map();
    let skip = 0;
    let pagesFetched = 0;
    let rawFetched = 0;
    let downloadedAllAvailable = false;
    let stoppedByMaxItems = false;

    while (pagesFetched < safeMaxPages) {
      const payload = await cpiGet("api/v1/MessageProcessingLogs", {
        $format: "json",
        $orderby: "LogEnd desc",
        $expand: "CustomHeaderProperties",
        $top: cachePageSize,
        $skip: skip,
        ...(pagesFetched === 0 ? { $inlinecount: "allpages" } : {})
      });

      if (pagesFetched === 0) {
        const inlineCountRaw = payload?.d?.__count ?? payload?.__count;
        const inlineCount = Number(inlineCountRaw);
        if (!Number.isNaN(inlineCount) && inlineCount >= 0) {
          messageCacheState.meta.estimatedTotalAvailable = inlineCount;
          messageCacheState.meta.targetDownloadCount = Math.min(inlineCount, safeMaxItems);
        } else {
          messageCacheState.meta.estimatedTotalAvailable = null;
          messageCacheState.meta.targetDownloadCount = Number.isFinite(safeMaxItems) ? safeMaxItems : null;
        }
      }

      const rawItems = normalizeCpiCollection(payload);
      if (rawItems.length === 0) {
        downloadedAllAvailable = true;
        break;
      }

      const mappedItems = mapMessages(rawItems, runtimePackageLookup);
      mappedItems.forEach((item) => {
        const ts = getMessageLogTimestamp(item);
        if (item.mplId && ts !== null && ts >= cutoffTs) {
          byId.set(item.mplId, item);
        }
      });

      if (byId.size >= safeMaxItems) {
        stoppedByMaxItems = true;
        break;
      }

      pagesFetched += 1;
      rawFetched += rawItems.length;
      messageCacheState.meta.pagesFetched = pagesFetched;
      messageCacheState.meta.rawFetched = rawFetched;
      if (messageCacheState.meta.targetDownloadCount && messageCacheState.meta.targetDownloadCount > 0) {
        messageCacheState.meta.progressPercent = Math.min(
          100,
          Math.round((rawFetched / messageCacheState.meta.targetDownloadCount) * 100)
        );
      } else {
        messageCacheState.meta.progressPercent = null;
      }

      const oldestInPageTs = mappedItems.reduce((min, item) => {
        const ts = getMessageLogTimestamp(item);
        if (ts === null) {
          return min;
        }

        if (min === null || ts < min) {
          return ts;
        }

        return min;
      }, null);

      skip += rawItems.length;

      if (rawItems.length < cachePageSize) {
        downloadedAllAvailable = true;
        break;
      }

      if (oldestInPageTs !== null && oldestInPageTs < cutoffTs) {
        break;
      }
    }

    const merged = Array.from(byId.values())
      .filter((item) => {
        const ts = getMessageLogTimestamp(item);
        return ts !== null && ts >= cutoffTs;
      })
      .sort((a, b) => {
        const tsA = getMessageLogTimestamp(a) || 0;
        const tsB = getMessageLogTimestamp(b) || 0;
        return tsB - tsA;
      });

    const retained = merged.slice(0, safeMaxItems);
    messageCacheState.meta.truncated = retained.length < merged.length || stoppedByMaxItems;

    retained.forEach((item) => {
      item.attachments = [];
      item.attachmentsLoaded = false;
    });

    if (preloadAttachmentsEnabled) {
      const maxItems = Number.isNaN(attachmentPrefetchLimit) || attachmentPrefetchLimit <= 0
        ? retained.length
        : Math.min(attachmentPrefetchLimit, retained.length);

      for (let i = 0; i < maxItems; i += 1) {
        const item = retained[i];
        try {
          const attachments = await fetchAttachmentsForMpl(item.mplId);
          item.attachments = attachments;
          item.attachmentsLoaded = true;
          if (attachments.length > 0) {
            messageCacheState.meta.attachmentsWithItems += 1;
          }
        } catch (_error) {
          item.attachments = [];
          item.attachmentsLoaded = true;
        }

        messageCacheState.meta.attachmentsProcessed = i + 1;
      }

      messageCacheState.meta.attachmentsFullyScanned = maxItems === retained.length;
    }

    messageCacheState.items = retained;
    messageCacheState.meta.downloadedAllAvailable = downloadedAllAvailable;
    messageCacheState.meta.lastSyncCompletedAt = new Date().toISOString();
    refreshCacheTimeBounds();
    messageCacheState.meta.progressPercent = 100;
    saveCacheToDisk();
  } catch (error) {
    messageCacheState.meta.lastSyncError = error.message;
  } finally {
    messageCacheState.sync.inProgress = false;
  }

  return true;
}

runtimeConfig.baseUrl = normalizeBaseUrl(runtimeConfig.baseUrl || process.env.CPI_BASE_URL || "");
loadCacheFromDisk();

app.use(morgan("dev"));
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "..", "public")));

function normalizeBaseUrl(rawUrl) {
  if (!rawUrl) {
    return "";
  }

  const trimmed = String(rawUrl).trim();
  if (!trimmed) {
    return "";
  }

  return trimmed.replace(/\/+$/, "").replace(/\/itspaces$/i, "");
}

function getConfigPreview() {
  return {
    baseUrl: runtimeConfig.baseUrl,
    authType: runtimeConfig.authType,
    hasBasicCredentials: Boolean(runtimeConfig.username && runtimeConfig.password),
    hasOAuthCredentials: Boolean(runtimeConfig.tokenUrl && runtimeConfig.clientId && runtimeConfig.clientSecret),
    source: "runtime-or-env"
  };
}

async function parseJsonResponseOrThrow(response, contextLabel) {
  const contentType = String(response.headers.get("content-type") || "").toLowerCase();
  const raw = await response.text();

  if (!contentType.includes("application/json")) {
    const sample = raw.slice(0, 180).replace(/\s+/g, " ").trim();
    throw new Error(
      `${contextLabel}: risposta non JSON (content-type='${contentType || "unknown"}'). Possibile redirect/login o URL errato. Estratto: ${sample}`
    );
  }

  try {
    return JSON.parse(raw);
  } catch (_error) {
    const sample = raw.slice(0, 180).replace(/\s+/g, " ").trim();
    throw new Error(`${contextLabel}: JSON non valido ricevuto. Estratto: ${sample}`);
  }
}

function normalizeCpiCollection(payload) {
  if (!payload) {
    return [];
  }

  if (Array.isArray(payload.value)) {
    return payload.value;
  }

  if (payload.d && Array.isArray(payload.d.results)) {
    return payload.d.results;
  }

  return [];
}

function parseInterfaceStatus(item) {
  const rawState =
    item.Status ||
    item.SemanticState ||
    item.ArtifactInformation ||
    item.DeploymentStatus ||
    "Unknown";

  const state = String(rawState);
  const normalized = state.toLowerCase();

  if (normalized.includes("start") || normalized.includes("run") || normalized.includes("deploy")) {
    return "Running";
  }

  if (normalized.includes("stop") || normalized.includes("undeploy")) {
    return "Stopped";
  }

  if (normalized.includes("error") || normalized.includes("fail")) {
    return "Error";
  }

  return state;
}

function parseMessageStatus(item) {
  const raw = item.Status || item.LogLevel || item.CustomStatus || "UNKNOWN";
  const status = String(raw).toUpperCase();

  if (status.includes("COMPLETED") || status.includes("SUCCESS")) {
    return "SUCCESS";
  }

  if (status.includes("FAILED") || status.includes("ERROR")) {
    return "FAILED";
  }

  if (status.includes("PROCESS")) {
    return "PROCESSING";
  }

  return status;
}

async function getOAuthToken() {
  const now = Date.now();

  if (oauthTokenCache.token && oauthTokenCache.expiresAt > now + 15000) {
    return oauthTokenCache.token;
  }

  const tokenUrl = runtimeConfig.tokenUrl;
  const clientId = runtimeConfig.clientId;
  const clientSecret = runtimeConfig.clientSecret;
  const scope = runtimeConfig.oauthScope;

  if (!tokenUrl || !clientId || !clientSecret) {
    throw new Error("Configurazione OAuth incompleta. Verifica CPI_TOKEN_URL, CPI_CLIENT_ID e CPI_CLIENT_SECRET.");
  }

  const body = new URLSearchParams();
  body.append("grant_type", "client_credentials");
  if (scope) {
    body.append("scope", scope);
  }

  const tokenResponse = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`
    },
    body
  });

  if (!tokenResponse.ok) {
    const reason = await tokenResponse.text();
    throw new Error(`Token OAuth non ottenuto (${tokenResponse.status}): ${reason}`);
  }

  const tokenPayload = await parseJsonResponseOrThrow(tokenResponse, "Token OAuth");
  const expiresIn = Number(tokenPayload.expires_in || 300);
  oauthTokenCache = {
    token: tokenPayload.access_token,
    expiresAt: now + expiresIn * 1000
  };

  return oauthTokenCache.token;
}

async function getAuthHeaders() {
  if (runtimeConfig.authType === "oauth") {
    const token = await getOAuthToken();
    return {
      Authorization: `Bearer ${token}`
    };
  }

  const username = runtimeConfig.username;
  const password = runtimeConfig.password;

  if (!username || !password) {
    throw new Error("Credenziali basic mancanti. Verifica CPI_USERNAME e CPI_PASSWORD.");
  }

  return {
    Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`
  };
}

async function cpiGet(endpoint, query = {}) {
  if (!runtimeConfig.baseUrl) {
    throw new Error("CPI_BASE_URL non configurato.");
  }

  const url = new URL(
    endpoint,
    runtimeConfig.baseUrl.endsWith("/") ? runtimeConfig.baseUrl : `${runtimeConfig.baseUrl}/`
  );

  Object.entries(query).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  });

  const authHeaders = await getAuthHeaders();
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      ...authHeaders
    }
  });

  if (!response.ok) {
    const reason = await response.text();
    throw new Error(`Richiesta SAP CPI fallita (${response.status}): ${reason}`);
  }

  return parseJsonResponseOrThrow(response, `Richiesta SAP CPI (${endpoint})`);
}

async function cpiFetchRawByUrl(urlInput, accept = "*/*") {
  if (!runtimeConfig.baseUrl) {
    throw new Error("CPI_BASE_URL non configurato.");
  }

  const base = new URL(runtimeConfig.baseUrl.endsWith("/") ? runtimeConfig.baseUrl : `${runtimeConfig.baseUrl}/`);
  const target = new URL(urlInput, base);

  if (target.host !== base.host) {
    throw new Error("URL allegato non valida: host non autorizzato.");
  }

  if (!target.pathname.startsWith("/api/v1/")) {
    throw new Error("URL allegato non valida: percorso non autorizzato.");
  }

  const authHeaders = await getAuthHeaders();
  const response = await fetch(target, {
    headers: {
      Accept: accept,
      ...authHeaders
    }
  });

  if (!response.ok) {
    const reason = await response.text();
    throw new Error(`Richiesta allegato SAP CPI fallita (${response.status}): ${reason}`);
  }

  return response;
}

function mapInterfaces(items, interfacePackageLookup = new Map()) {
  return items.map((item) => {
    const id = item.Id || item.Name || item.ArtifactName || "n/a";
    const name = item.Name || item.ArtifactName || item.Id || "Sconosciuta";

    let packageValue = item.Package || item.ArtifactPackage || item.PackageName || item.ParentPackage;
    if ((!packageValue || packageValue === "UNKNOWN") && interfacePackageLookup.has(String(id))) {
      packageValue = interfacePackageLookup.get(String(id));
    }
    if ((!packageValue || packageValue === "UNKNOWN") && interfacePackageLookup.has(String(name))) {
      packageValue = interfacePackageLookup.get(String(name));
    }

    return {
      id,
      name,
      version: item.Version || item.ActiveVersion || "-",
      deployedOn: item.DeployedOn || item.DeployedOnDate || item.CreatedAt || null,
      status: parseInterfaceStatus(item),
      package: packageValue || "UNKNOWN"
    };
  });
}

async function buildInterfacePackageLookup() {
  const lookup = new Map();
  const pageSize = 200;
  let skip = 0;

  while (true) {
    const packagesPayload = await cpiGet("api/v1/IntegrationPackages", {
      $format: "json",
      $top: pageSize,
      $skip: skip
    });

    const packages = normalizeCpiCollection(packagesPayload);
    if (packages.length === 0) {
      break;
    }

    // Fetch package contents in parallel but avoid unbounded fan-out.
    for (const pkg of packages) {
      const packageId = String(pkg.Id || "").trim();
      if (!packageId) {
        continue;
      }

      let artifactSkip = 0;
      const artifactPageSize = 500;

      while (true) {
        const endpoint = `api/v1/IntegrationPackages('${packageId.replace(/'/g, "''")}')/IntegrationDesigntimeArtifacts`;
        const artifactsPayload = await cpiGet(endpoint, {
          $format: "json",
          $top: artifactPageSize,
          $skip: artifactSkip
        });

        const artifacts = normalizeCpiCollection(artifactsPayload);
        if (artifacts.length === 0) {
          break;
        }

        artifacts.forEach((artifact) => {
          const artifactId = String(artifact.Id || "").trim();
          const artifactName = String(artifact.Name || "").trim();
          const artifactPackage = String(artifact.PackageId || packageId).trim();

          if (artifactId && artifactPackage) {
            lookup.set(artifactId, artifactPackage);
          }

          if (artifactName && artifactPackage) {
            lookup.set(artifactName, artifactPackage);
          }
        });

        artifactSkip += artifacts.length;
        if (artifacts.length < artifactPageSize) {
          break;
        }
      }
    }

    skip += packages.length;
    if (packages.length < pageSize) {
      break;
    }
  }

  return lookup;
}

async function getInterfacePackageLookup() {
  const now = Date.now();
  if (interfacePackageLookupCache.lookup.size > 0 && interfacePackageLookupCache.expiresAt > now) {
    return interfacePackageLookupCache.lookup;
  }

  if (interfacePackageLookupCache.inFlight) {
    return interfacePackageLookupCache.inFlight;
  }

  interfacePackageLookupCache.inFlight = buildInterfacePackageLookup()
    .then((lookup) => {
      interfacePackageLookupCache.lookup = lookup;
      interfacePackageLookupCache.expiresAt = Date.now() + 10 * 60 * 1000;
      interfacePackageLookupCache.inFlight = null;
      return lookup;
    })
    .catch((error) => {
      interfacePackageLookupCache.inFlight = null;
      throw error;
    });

  return interfacePackageLookupCache.inFlight;
}

function buildRuntimePackageLookup(interfaces) {
  const lookup = new Map();
  const setLookup = (key, packageName) => {
    const normalized = String(key || "").trim();
    if (!normalized) {
      return;
    }

    lookup.set(normalized, packageName);
    lookup.set(normalized.toLowerCase(), packageName);
  };

  interfaces.forEach((item) => {
    const packageName = item.package;
    if (!packageName || packageName === "UNKNOWN") {
      return;
    }

    setLookup(item.id, packageName);
    setLookup(item.name, packageName);
  });

  return lookup;
}

function mapAttachmentItem(item) {
  const metadata = item.__metadata || {};
  const mediaSrc = metadata.media_src || metadata.edit_media || "";
  const contentType = item.ContentType || metadata.content_type || "application/octet-stream";
  const fileName = item.Name || item.Id || "attachment";

  return {
    id: item.Id || "n/a",
    name: fileName,
    contentType,
    payloadSize: item.PayloadSize || null,
    timestamp: item.TimeStamp || null,
    downloadUrl: mediaSrc
      ? `/api/cpi/attachments/content?uri=${encodeURIComponent(mediaSrc)}&name=${encodeURIComponent(fileName)}`
      : null
  };
}

function sanitizeZipSegment(value, fallback = "unknown") {
  const cleaned = String(value || "")
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replace(/\s+/g, "-")
    .replace(/\.+/g, ".")
    .replace(/^\.+/, "")
    .replace(/\.+$/, "")
    .slice(0, 80);

  return cleaned || fallback;
}

function formatZipTimestampFromMessage(message) {
  const ts = getMessageLogTimestamp(message);
  if (ts === null) {
    return "no-ts";
  }

  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) {
    return "no-ts";
  }

  const yyyy = String(date.getUTCFullYear());
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  const hh = String(date.getUTCHours()).padStart(2, "0");
  const mi = String(date.getUTCMinutes()).padStart(2, "0");
  const ss = String(date.getUTCSeconds()).padStart(2, "0");

  return `${yyyy}${mm}${dd}_${hh}${mi}${ss}Z`;
}

function parseAttachmentUriFromDownloadUrl(downloadUrl) {
  if (!downloadUrl) {
    return "";
  }

  try {
    const parsed = new URL(downloadUrl, "http://localhost");
    return String(parsed.searchParams.get("uri") || "").trim();
  } catch (_error) {
    return "";
  }
}

function buildAttachmentExportFileName(filters) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const chunks = ["mpl-attachments", stamp];

  if (filters.packageFilter) {
    chunks.push(`pkg-${sanitizeZipSegment(filters.packageFilter, "pkg")}`);
  }

  if (filters.iflowFilter) {
    chunks.push(`iflow-${sanitizeZipSegment(filters.iflowFilter, "iflow")}`);
  }

  if (filters.statusFilter) {
    chunks.push(`status-${sanitizeZipSegment(filters.statusFilter, "status")}`);
  }

  return `${chunks.join("_")}.zip`;
}

async function fetchAttachmentsForMpl(mplId) {
  const safeMplId = String(mplId || "").trim().replace(/'/g, "''");
  if (!safeMplId) {
    return [];
  }

  let payload;
  try {
    payload = await cpiGet(`api/v1/MessageProcessingLogs('${safeMplId}')/Attachments`, {
      $format: "json"
    });
  } catch (error) {
    const raw = String(error.message || "");
    const notFound = raw.includes("(404)") || raw.includes("ObjectNotFound") || raw.includes("Not Found");
    if (notFound) {
      return [];
    }
    throw error;
  }

  return normalizeCpiCollection(payload).map(mapAttachmentItem);
}

async function resolveMessageLogIdFromGuid(messageGuid) {
  const safeGuid = String(messageGuid || "").trim().replace(/'/g, "''");
  if (!safeGuid) {
    return null;
  }

  const payload = await cpiGet("api/v1/MessageProcessingLogs", {
    $format: "json",
    $top: 1,
    $filter: `MessageGuid eq '${safeGuid}'`
  });

  const match = normalizeCpiCollection(payload)[0];
  return match?.Id ? String(match.Id).trim() : null;
}

async function fetchAttachmentsForMplWithFallback(mplIdOrGuid) {
  const candidate = String(mplIdOrGuid || "").trim();
  if (!candidate) {
    return {
      items: [],
      resolvedId: candidate
    };
  }

  try {
    const items = await fetchAttachmentsForMpl(candidate);
    return {
      items,
      resolvedId: candidate
    };
  } catch (error) {
    const isNotFound = String(error.message || "").includes("(404)") || String(error.message || "").includes("ObjectNotFound");
    if (!isNotFound) {
      throw error;
    }

    const resolvedId = await resolveMessageLogIdFromGuid(candidate);
    if (!resolvedId || resolvedId === candidate) {
      throw error;
    }

    const items = await fetchAttachmentsForMpl(resolvedId);
    return {
      items,
      resolvedId
    };
  }
}

function countCpiCollection(payload) {
  return normalizeCpiCollection(payload).length;
}

function hasNonEmptyCpiEntity(payload) {
  if (!payload) {
    return false;
  }

  const root = payload.d && typeof payload.d === "object" ? payload.d : payload;
  if (!root || typeof root !== "object") {
    return false;
  }

  const keys = Object.keys(root).filter((key) => key !== "__metadata" && key !== "results");
  return keys.some((key) => {
    const value = root[key];
    if (value === null || value === undefined) {
      return false;
    }

    if (typeof value === "string") {
      return value.trim().length > 0;
    }

    if (typeof value === "number" || typeof value === "boolean") {
      return true;
    }

    if (Array.isArray(value)) {
      return value.length > 0;
    }

    if (typeof value === "object") {
      return Object.keys(value).length > 0;
    }

    return false;
  });
}

async function fetchMplDiagnostics(mplId) {
  const safeMplId = String(mplId || "").trim().replace(/'/g, "''");
  if (!safeMplId) {
    return null;
  }

  const diagnostics = {
    status: null,
    integrationFlow: null,
    package: null,
    archivingLogAttachments: null,
    messageStoreEntriesCount: 0,
    runsCount: 0,
    hasErrorInformation: false
  };

  try {
    const logPayload = await cpiGet(`api/v1/MessageProcessingLogs('${safeMplId}')`, {
      $format: "json"
    });

    const logRoot = logPayload?.d || logPayload || {};
    diagnostics.status = logRoot.Status || logRoot.CustomStatus || null;
    diagnostics.integrationFlow = logRoot.IntegrationFlowName || null;
    diagnostics.package =
      logRoot?.IntegrationArtifact?.PackageName ||
      logRoot?.IntegrationArtifact?.PackageId ||
      null;
    diagnostics.archivingLogAttachments =
      typeof logRoot.ArchivingLogAttachments === "boolean" ? logRoot.ArchivingLogAttachments : null;
  } catch (_error) {
    // If this lookup fails we still return any counts we can collect below.
  }

  const [storePayload, runsPayload, errorPayload] = await Promise.all([
    cpiGet(`api/v1/MessageProcessingLogs('${safeMplId}')/MessageStoreEntries`, {
      $format: "json"
    }).catch(() => null),
    cpiGet(`api/v1/MessageProcessingLogs('${safeMplId}')/Runs`, {
      $format: "json"
    }).catch(() => null),
    cpiGet(`api/v1/MessageProcessingLogs('${safeMplId}')/ErrorInformation`, {
      $format: "json"
    }).catch(() => null)
  ]);

  diagnostics.messageStoreEntriesCount = countCpiCollection(storePayload);
  diagnostics.runsCount = countCpiCollection(runsPayload);
  diagnostics.hasErrorInformation = countCpiCollection(errorPayload) > 0 || hasNonEmptyCpiEntity(errorPayload);

  return diagnostics;
}

function mapMessages(items, runtimePackageLookup = new Map()) {
  return items.map((item) => {
    const artifact = item.IntegrationArtifact || {};
    const customHeaders = Array.isArray(item.CustomHeaderProperties?.results)
      ? item.CustomHeaderProperties.results
          .map((header) => ({
            name: header.Name || header.name || "",
            value: header.Value || header.value || ""
          }))
          .filter((header) => header.name)
      : [];

    const flowName =
      artifact.Name ||
      item.IntegrationFlowName ||
      artifact.Id ||
      item.ApplicationMessageId ||
      "N/D";

    let packageValue =
      artifact.PackageName ||
      artifact.PackageId ||
      item.Package ||
      item.IntegrationPackageName ||
      item.IntegrationPackageId;

    if (!packageValue || packageValue === "UNKNOWN") {
      const lookupCandidates = [
        flowName,
        item.IntegrationFlowName,
        artifact.Id,
        artifact.Name,
        item.IntegrationArtifactId,
        item.IntegrationArtifactName
      ];

      for (const candidate of lookupCandidates) {
        const key = String(candidate || "").trim();
        if (!key) {
          continue;
        }

        if (runtimePackageLookup.has(key)) {
          packageValue = runtimePackageLookup.get(key);
          break;
        }

        const lowered = key.toLowerCase();
        if (runtimePackageLookup.has(lowered)) {
          packageValue = runtimePackageLookup.get(lowered);
          break;
        }
      }
    }

    const logObjectId = item.Id || item.MessageGuid || "n/a";
    const messageGuid = item.MessageGuid || item.Id || "n/a";

    return {
      id: logObjectId,
      mplId: logObjectId,
      messageGuid,
      logLink: item.AlternateWebLink || item.AlternateWeblink || "",
      integrationFlow: flowName,
      status: parseMessageStatus(item),
      logStart: item.LogStart || item.StartTime || null,
      logEnd: item.LogEnd || item.EndTime || null,
      sender: item.Sender || item.SenderParty || "-",
      receiver: item.Receiver || item.ReceiverParty || "-",
      package: packageValue || "UNKNOWN",
      customHeaders
    };
  });
}

function buildStats(interfaces, messages) {
  const runningInterfaces = interfaces.filter((item) => item.status === "Running").length;
  const erroredInterfaces = interfaces.filter((item) => item.status === "Error").length;

  const successMessages = messages.filter((msg) => msg.status === "SUCCESS").length;
  const failedMessages = messages.filter((msg) => msg.status === "FAILED").length;
  const processingMessages = messages.filter((msg) => msg.status === "PROCESSING").length;

  return {
    interfaces: {
      total: interfaces.length,
      running: runningInterfaces,
      error: erroredInterfaces
    },
    messages: {
      total: messages.length,
      success: successMessages,
      failed: failedMessages,
      processing: processingMessages
    }
  };
}

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    service: "cpiguardian",
    timestamp: new Date().toISOString()
  });
});

app.get("/api/config", (_req, res) => {
  res.json({
    ok: true,
    configured: Boolean(runtimeConfig.baseUrl),
    config: getConfigPreview()
  });
});

app.post("/api/config/service-key", (req, res) => {
  try {
    const payload = req.body || {};
    const oauth = payload.oauth || {};

    const baseUrl = normalizeBaseUrl(oauth.url || payload.url);
    const tokenUrl = String(oauth.tokenurl || payload.tokenurl || "").trim();
    const clientId = String(oauth.clientid || payload.clientid || "").trim();
    const clientSecret = String(oauth.clientsecret || payload.clientsecret || "").trim();
    const oauthScope = String(oauth.scope || payload.scope || "").trim();

    if (!baseUrl || !tokenUrl || !clientId || !clientSecret) {
      return res.status(400).json({
        error:
          "Service key non valida. Campi richiesti: oauth.url, oauth.tokenurl, oauth.clientid, oauth.clientsecret."
      });
    }

    const previousBaseUrl = normalizeBaseUrl(runtimeConfig.baseUrl || "");
    runtimeConfig.baseUrl = baseUrl;
    runtimeConfig.authType = "oauth";
    runtimeConfig.tokenUrl = tokenUrl;
    runtimeConfig.clientId = clientId;
    runtimeConfig.clientSecret = clientSecret;
    runtimeConfig.oauthScope = oauthScope;

    // Reset token cache after updating OAuth credentials.
    oauthTokenCache = {
      token: null,
      expiresAt: 0
    };

    resetInterfacePackageLookupCache();

    if (previousBaseUrl !== runtimeConfig.baseUrl) {
      resetMessageCache(runtimeConfig.baseUrl || null);
      saveCacheToDisk();
    }

    return res.json({
      ok: true,
      message: "Service key caricata correttamente.",
      config: getConfigPreview()
    });
  } catch (error) {
    return res.status(500).json({
      error: `Errore in parsing service key: ${error.message}`
    });
  }
});

app.get("/api/cpi/interfaces", async (req, res) => {
  try {
    const statusFilter = (req.query.status || "").toString().trim().toLowerCase();
    const [payload, packageLookup] = await Promise.all([
      cpiGet("api/v1/IntegrationRuntimeArtifacts", {
        $format: "json"
      }),
      getInterfacePackageLookup()
    ]);

    let interfaces = mapInterfaces(normalizeCpiCollection(payload), packageLookup);

    if (statusFilter) {
      interfaces = interfaces.filter((item) => item.status.toLowerCase() === statusFilter);
    }

    res.json({
      count: interfaces.length,
      items: interfaces
    });
  } catch (error) {
    res.status(500).json({
      error: error.message
    });
  }
});

app.get("/api/cpi/messages", async (req, res) => {
  try {
    const top = Number(req.query.top || messagesTop);
    const statusFilter = (req.query.status || "").toString().trim().toUpperCase();
    const interfaceNameFilter = (req.query.interfaceName || "").toString().trim();
    const interfaceIdFilter = (req.query.interfaceId || "").toString().trim();
    const timeRangeFilter = (req.query.timeRange || "").toString().trim();
    const safeTop = Number.isNaN(top) ? messagesTop : Math.max(1, Math.min(top, 5000));
    const timeThreshold = getTimeThresholdMs(timeRangeFilter);

    const fetchMessagePayload = ({ topValue = safeTop, skipValue = 0, filterExpr = "" } = {}) =>
      cpiGet("api/v1/MessageProcessingLogs", {
        $format: "json",
        $orderby: "LogEnd desc",
        $expand: "CustomHeaderProperties",
        $top: topValue,
        $skip: skipValue,
        ...(filterExpr ? { $filter: filterExpr } : {})
      });

    const [interfacesPayload, packageLookup] = await Promise.all([
      cpiGet("api/v1/IntegrationRuntimeArtifacts", {
        $format: "json"
      }),
      getInterfacePackageLookup()
    ]);

    let rawMessageItems = [];
    if (interfaceNameFilter || interfaceIdFilter) {
      const normalizedDisplayName = String(interfaceNameFilter || "").trim().toLowerCase();
      const aliases = new Map();
      const addAlias = (value) => {
        const raw = String(value || "").trim();
        if (!raw) {
          return;
        }

        const key = raw.toLowerCase();
        if (!aliases.has(key)) {
          aliases.set(key, raw);
        }
      };

      if (normalizedDisplayName) {
        interfacesPayload
          && normalizeCpiCollection(interfacesPayload)
            .map((item) => mapInterfaces([item], packageLookup)[0])
            .filter(Boolean)
            .forEach((row) => {
              const rowName = String(row.name || "").trim().toLowerCase();
              if (rowName === normalizedDisplayName) {
                addAlias(row.name);
                addAlias(row.id);
              }
            });
      }

      if (aliases.size === 0) {
        [interfaceNameFilter, interfaceIdFilter]
          .forEach((value) => addAlias(value));
      }

      const escapedAliases = Array.from(aliases.values())
        .map((value) => String(value || "").trim())
        .filter(Boolean)
        .map((value) => value.replace(/'/g, "''"));

      const interfaceExprParts = [];
      escapedAliases.forEach((value) => {
        interfaceExprParts.push(`IntegrationArtifact/Id eq '${value}'`);
        interfaceExprParts.push(`IntegrationArtifact/Name eq '${value}'`);
        interfaceExprParts.push(`IntegrationFlowName eq '${value}'`);
      });

      let combinedFilterExpr = interfaceExprParts.length > 0 ? `(${interfaceExprParts.join(" or ")})` : "";
      if (timeThreshold !== null) {
        const iso = new Date(timeThreshold).toISOString().replace(/\.\d{3}Z$/, "");
        const timeExpr = `LogStart ge datetime'${iso}'`;
        combinedFilterExpr = combinedFilterExpr ? `${combinedFilterExpr} and ${timeExpr}` : timeExpr;
      }

      const payload = await fetchMessagePayload({
        topValue: safeTop,
        skipValue: 0,
        filterExpr: combinedFilterExpr
      });
      rawMessageItems = normalizeCpiCollection(payload);
    } else {
      let baseFilterExpr = "";
      if (timeThreshold !== null) {
        const iso = new Date(timeThreshold).toISOString().replace(/\.\d{3}Z$/, "");
        baseFilterExpr = `LogStart ge datetime'${iso}'`;
      }

      const messagesPayload = await fetchMessagePayload({ topValue: safeTop, skipValue: 0, filterExpr: baseFilterExpr });
      rawMessageItems = normalizeCpiCollection(messagesPayload);
    }

    const interfaces = mapInterfaces(normalizeCpiCollection(interfacesPayload), packageLookup);
    const runtimePackageLookup = buildRuntimePackageLookup(interfaces);

    let messages = mapMessages(rawMessageItems, runtimePackageLookup);
    messages.sort((a, b) => (getMessageLogTimestamp(b) || 0) - (getMessageLogTimestamp(a) || 0));
    if (messages.length > safeTop) {
      messages = messages.slice(0, safeTop);
    }

    if (statusFilter) {
      messages = messages.filter((msg) => msg.status === statusFilter);
    }

    if (timeThreshold !== null) {
      messages = messages.filter((msg) => {
        const ts = getMessageLogTimestamp(msg);
        return ts !== null && ts >= timeThreshold;
      });
    }

    res.json({
      count: messages.length,
      items: messages
    });
  } catch (error) {
    res.status(500).json({
      error: error.message
    });
  }
});

app.get("/api/cpi/messages/:mplId/attachments", async (req, res) => {
  try {
    const mplId = String(req.params.mplId || "").trim();
    if (!mplId) {
      return res.status(400).json({ error: "MPL ID mancante." });
    }

    const resolved = await fetchAttachmentsForMplWithFallback(mplId);
    const attachments = resolved.items;
    const diagnostics = await fetchMplDiagnostics(resolved.resolvedId || mplId);

    return res.json({
      ok: true,
      mplId,
      resolvedMplId: resolved.resolvedId,
      count: attachments.length,
      items: attachments,
      diagnostics
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.get("/api/cpi/attachments/content", async (req, res) => {
  try {
    const uri = String(req.query.uri || "").trim();
    const fileNameRaw = String(req.query.name || "attachment").trim();
    const fileName = fileNameRaw.replace(/[\r\n\"]/g, "_") || "attachment";

    if (!uri) {
      return res.status(400).json({ error: "Parametro uri mancante." });
    }

    const response = await cpiFetchRawByUrl(uri, "*/*");
    const contentType = response.headers.get("content-type") || "application/octet-stream";
    const contentDisposition = `inline; filename="${fileName}"`;
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Disposition", contentDisposition);
    return res.send(buffer);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.get("/api/cpi/attachments/preview", async (req, res) => {
  try {
    const uri = String(req.query.uri || "").trim();
    const fileNameRaw = String(req.query.name || "attachment").trim();
    const fileName = fileNameRaw.replace(/[\r\n\"]/g, "_") || "attachment";
    const maxBytes = Number(req.query.maxBytes || 1024 * 1024);

    if (!uri) {
      return res.status(400).json({ error: "Parametro uri mancante." });
    }

    const response = await cpiFetchRawByUrl(uri, "*/*");
    const contentType = String(response.headers.get("content-type") || "application/octet-stream").toLowerCase();
    const arrayBuffer = await response.arrayBuffer();
    const fullBuffer = Buffer.from(arrayBuffer);

    const textualTypes = [
      "text/",
      "application/json",
      "application/xml",
      "application/javascript",
      "application/x-javascript",
      "application/xhtml+xml",
      "application/csv"
    ];

    const isText = textualTypes.some((prefix) => contentType.startsWith(prefix));
    const safeMaxBytes = Number.isNaN(maxBytes) ? 1024 * 1024 : Math.max(1024, Math.min(maxBytes, 5 * 1024 * 1024));
    const truncated = fullBuffer.length > safeMaxBytes;
    const previewBuffer = truncated ? fullBuffer.subarray(0, safeMaxBytes) : fullBuffer;

    return res.json({
      ok: true,
      name: fileName,
      contentType,
      size: fullBuffer.length,
      isText,
      truncated,
      text: isText ? previewBuffer.toString("utf8") : null,
      downloadUrl: `/api/cpi/attachments/content?uri=${encodeURIComponent(uri)}&name=${encodeURIComponent(fileName)}`
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.get("/api/cpi/attachments/export/progress/:progressId", (req, res) => {
  const progressId = String(req.params.progressId || "").trim();
  if (!progressId) {
    return res.status(400).json({
      error: "Progress ID mancante."
    });
  }

  const state = attachmentExportProgress.get(progressId);
  if (!state) {
    return res.status(404).json({
      error: "Progress non trovato o scaduto."
    });
  }

  return res.json({
    ok: true,
    progressId,
    state
  });
});

app.get("/api/cpi/attachments/export.zip", async (req, res) => {
  const packageFilter = String(req.query.package || "").trim();
  const iflowFilter = String(req.query.iflow || "").trim();
  const statusFilter = String(req.query.status || "").trim().toUpperCase();
  const timeRangeFilter = String(req.query.timeRange || "").trim();
  const timeThreshold = getTimeThresholdMs(timeRangeFilter);
  const progressId = String(req.query.progressId || "").trim();
  const includeUnknown = String(req.query.includeUnknown || "false").toLowerCase() === "true";

  const progressState = {
    status: "running",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    totalMpl: 0,
    mplProcessed: 0,
    mplWithAttachments: 0,
    attachmentsAdded: 0,
    errorsCount: 0,
    message: "Preparazione export in corso..."
  };

  if (progressId) {
    attachmentExportProgress.set(progressId, progressState);
  }

  const requestedLimitMpl = Number(req.query.limitMpl || 0);
  const safeLimitMpl =
    Number.isNaN(requestedLimitMpl) || requestedLimitMpl <= 0 ? Number.MAX_SAFE_INTEGER : Math.min(requestedLimitMpl, 5000);

  if (messageCacheState.sync.inProgress) {
    return res.status(409).json({
      error: "Sincronizzazione cache in corso. Riprova al termine del download log."
    });
  }

  let sourceMessages = messageCacheState.items.slice();
  if (!includeUnknown) {
    sourceMessages = sourceMessages.filter((item) => item.package && item.package !== "UNKNOWN");
  }

  if (iflowFilter) {
    try {
      const [interfacesPayload, packageLookup] = await Promise.all([
        cpiGet("api/v1/IntegrationRuntimeArtifacts", {
          $format: "json"
        }),
        getInterfacePackageLookup()
      ]);

      const interfaces = mapInterfaces(normalizeCpiCollection(interfacesPayload), packageLookup);
      const runtimePackageLookup = buildRuntimePackageLookup(interfaces);
      const normalizedFilter = iflowFilter.toLowerCase();

      const aliasValues = new Set();
      interfaces.forEach((item) => {
        const name = String(item.name || "").trim();
        const id = String(item.id || "").trim();
        if (!name && !id) {
          return;
        }

        if (name.toLowerCase() === normalizedFilter || id.toLowerCase() === normalizedFilter) {
          if (name) {
            aliasValues.add(name);
          }

          if (id) {
            aliasValues.add(id);
          }
        }
      });

      if (aliasValues.size === 0) {
        aliasValues.add(iflowFilter);
      }

      const escapedAliases = Array.from(aliasValues)
        .map((value) => String(value || "").trim())
        .filter(Boolean)
        .map((value) => value.replace(/'/g, "''"));

      const flowExprParts = [];
      escapedAliases.forEach((value) => {
        flowExprParts.push(`IntegrationArtifact/Id eq '${value}'`);
        flowExprParts.push(`IntegrationArtifact/Name eq '${value}'`);
        flowExprParts.push(`IntegrationFlowName eq '${value}'`);
      });

      let combinedFilter = flowExprParts.length > 0 ? `(${flowExprParts.join(" or ")})` : "";
      if (timeThreshold !== null) {
        const iso = new Date(timeThreshold).toISOString().replace(/\.\d{3}Z$/, "");
        const timeExpr = `LogStart ge datetime'${iso}'`;
        combinedFilter = combinedFilter ? `${combinedFilter} and ${timeExpr}` : timeExpr;
      }

      const liveTop = Math.min(safeLimitMpl, 5000);
      const livePayload = await cpiGet("api/v1/MessageProcessingLogs", {
        $format: "json",
        $orderby: "LogEnd desc",
        $expand: "CustomHeaderProperties",
        $top: liveTop,
        ...(combinedFilter ? { $filter: combinedFilter } : {})
      });

      const liveMessages = mapMessages(normalizeCpiCollection(livePayload), runtimePackageLookup);
      const allowedAliases = new Set(Array.from(aliasValues).map((value) => String(value).toLowerCase()));

      sourceMessages = liveMessages.filter((item) => {
        const flow = String(item.integrationFlow || "").toLowerCase();
        return flow && allowedAliases.has(flow);
      });
    } catch (_error) {
      // Keep cache-based fallback if live query fails.
    }
  }

  if (packageFilter) {
    sourceMessages = sourceMessages.filter((item) => String(item.package || "") === packageFilter);
  }

  if (statusFilter) {
    sourceMessages = sourceMessages.filter((item) => String(item.status || "").toUpperCase() === statusFilter);
  }

  if (timeThreshold !== null) {
    sourceMessages = sourceMessages.filter((item) => {
      const ts = getMessageLogTimestamp(item);
      return ts !== null && ts >= timeThreshold;
    });
  }

  sourceMessages = sourceMessages.slice(0, safeLimitMpl);

  const filters = {
    packageFilter,
    iflowFilter,
    statusFilter
  };
  const fileName = buildAttachmentExportFileName(filters);

  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename=\"${fileName}\"`);

  const archive = createZipArchive({
    zlib: { level: 9 }
  });

  progressState.totalMpl = sourceMessages.length;
  if (sourceMessages.length === 0) {
    progressState.status = "finalizing";
    progressState.message = "Nessun log compatibile con i filtri. Generazione report export.";
  }

  archive.on("error", (error) => {
    if (progressId) {
      progressState.status = "failed";
      progressState.finishedAt = new Date().toISOString();
      progressState.message = error.message;
    }

    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
      return;
    }

    res.destroy(error);
  });

  archive.pipe(res);

  const usedPaths = new Set();
  const errors = [];
  let mplProcessed = 0;
  let mplWithAttachments = 0;
  let attachmentsAdded = 0;

  for (const message of sourceMessages) {
    const mplId = String(message.mplId || message.id || "").trim();
    if (!mplId) {
      continue;
    }

    mplProcessed += 1;
    if (progressId) {
      progressState.mplProcessed = mplProcessed;
      progressState.message = `Analisi log ${mplProcessed}/${sourceMessages.length}`;
    }
    const packageName = sanitizeZipSegment(message.package || "UNKNOWN", "UNKNOWN");
    const flowName = sanitizeZipSegment(message.integrationFlow || "iflow", "iflow");
    const mplTimestamp = formatZipTimestampFromMessage(message);
    const mplFolder = sanitizeZipSegment(`${mplTimestamp}_${mplId}`, "mpl");

    let attachments = [];
    try {
      if (message.attachmentsLoaded && Array.isArray(message.attachments)) {
        attachments = message.attachments;
      } else {
        const resolved = await fetchAttachmentsForMplWithFallback(mplId);
        attachments = resolved.items;
      }
    } catch (error) {
      errors.push({
        mplId,
        stage: "attachments-list",
        error: error.message
      });
      continue;
    }

    if (!Array.isArray(attachments) || attachments.length === 0) {
      continue;
    }

    mplWithAttachments += 1;
    if (progressId) {
      progressState.mplWithAttachments = mplWithAttachments;
    }

    for (let index = 0; index < attachments.length; index += 1) {
      const attachment = attachments[index];
      const uri = parseAttachmentUriFromDownloadUrl(attachment.downloadUrl);
      if (!uri) {
        errors.push({
          mplId,
          stage: "attachment-uri",
          attachment: attachment.name || attachment.id || `item-${index + 1}`,
          error: "URI allegato non disponibile"
        });
        continue;
      }

      const attachmentName = sanitizeZipSegment(attachment.name || attachment.id || `attachment-${index + 1}`, `attachment-${index + 1}`);
      const basePath = `${packageName}/${flowName}/${mplFolder}/${String(index + 1).padStart(2, "0")}_${attachmentName}`;

      let archivePath = basePath;
      let duplicateCount = 1;
      while (usedPaths.has(archivePath)) {
        duplicateCount += 1;
        archivePath = `${basePath}_${duplicateCount}`;
      }
      usedPaths.add(archivePath);

      try {
        const raw = await cpiFetchRawByUrl(uri, "*/*");
        const payloadBuffer = Buffer.from(await raw.arrayBuffer());
        archive.append(payloadBuffer, { name: archivePath });
        attachmentsAdded += 1;
        if (progressId) {
          progressState.attachmentsAdded = attachmentsAdded;
        }
      } catch (error) {
        errors.push({
          mplId,
          stage: "attachment-download",
          attachment: attachment.name || attachment.id || `item-${index + 1}`,
          error: error.message
        });
        if (progressId) {
          progressState.errorsCount = errors.length;
        }
      }
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    filters: {
      package: packageFilter || null,
      iflow: iflowFilter || null,
      status: statusFilter || null,
      timeRange: timeRangeFilter || null,
      includeUnknown
    },
    sourceMessagesCount: sourceMessages.length,
    mplProcessed,
    mplWithAttachments,
    attachmentsAdded,
    errorsCount: errors.length,
    errors,
    note:
      sourceMessages.length === 0
        ? "Nessun log in cache compatibile con i filtri selezionati."
        : null
  };

  archive.append(JSON.stringify(report, null, 2), {
    name: "_export-report.json"
  });

  if (progressId) {
    progressState.status = "finalizing";
    progressState.message = "Finalizzazione ZIP...";
    progressState.errorsCount = errors.length;
  }

  await archive.finalize();

  if (progressId) {
    progressState.status = "completed";
    progressState.finishedAt = new Date().toISOString();
    progressState.message = "Export completato";
    progressState.errorsCount = errors.length;

    setTimeout(() => {
      attachmentExportProgress.delete(progressId);
    }, 15 * 60 * 1000);
  }
});

app.get("/api/cpi/overview", async (_req, res) => {
  try {
    const [interfacesPayload, messagesPayload, packageLookup] = await Promise.all([
      cpiGet("api/v1/IntegrationRuntimeArtifacts", {
        $format: "json"
      }),
      cpiGet("api/v1/MessageProcessingLogs", {
        $format: "json",
        $orderby: "LogEnd desc",
        $expand: "CustomHeaderProperties",
        $top: messagesTop
      }),
      getInterfacePackageLookup()
    ]);

    const interfaces = mapInterfaces(normalizeCpiCollection(interfacesPayload), packageLookup);
    const runtimePackageLookup = buildRuntimePackageLookup(interfaces);
    const messages = mapMessages(normalizeCpiCollection(messagesPayload), runtimePackageLookup);
    const stats = buildStats(interfaces, messages);

    res.json({
      timestamp: new Date().toISOString(),
      stats,
      interfaces,
      messages
    });
  } catch (error) {
    res.status(500).json({
      error: error.message
    });
  }
});

app.get("/api/cache/messages/status", (_req, res) => {
  res.json({
    ok: true,
    inProgress: messageCacheState.sync.inProgress,
    meta: messageCacheState.meta
  });
});

app.post("/api/cache/messages/sync", async (req, res) => {
  const force = Boolean(req.body?.force) || String(req.query.force || "").toLowerCase() === "true";
  const requestedMaxItemsRaw = req.body?.maxItems ?? req.query.maxItems;
  const requestedMaxItems = Number(requestedMaxItemsRaw);
  const maxItemsOverride =
    Number.isNaN(requestedMaxItems) || requestedMaxItems <= 0
      ? null
      : Math.min(requestedMaxItems, Number.MAX_SAFE_INTEGER);

  if (messageCacheState.sync.inProgress) {
    return res.status(409).json({
      ok: false,
      error: "Sincronizzazione gia in corso"
    });
  }

  syncMessagesCache({ force, maxItemsOverride }).catch((error) => {
    messageCacheState.meta.lastSyncError = error.message;
    messageCacheState.sync.inProgress = false;
  });

  return res.status(202).json({
    ok: true,
    started: true
  });
});

// Get distinct systems/packages and flows from SAP CPI (not from cache)
app.get("/api/cache/systems", async (_req, res) => {
  try {
    const systems = new Set();
    const flowsBySystem = new Map();
    const allFlows = new Set();

    // Ottieni gli interface direttamente da SAP CPI (stesso metodo di /api/cpi/overview)
    const [interfacesPayload, packageLookup] = await Promise.all([
      cpiGet("api/v1/IntegrationRuntimeArtifacts", {
        $format: "json"
      }),
      getInterfacePackageLookup()
    ]);

    const interfaces = mapInterfaces(normalizeCpiCollection(interfacesPayload), packageLookup);

    // Estrai sistemi e flow dai interface
    interfaces.forEach((item) => {
      const pkg = String(item.package || "").trim();
      const name = String(item.name || "").trim();

      if (pkg && pkg !== "UNKNOWN") {
        systems.add(pkg);
        
        if (name) {
          if (!flowsBySystem.has(pkg)) {
            flowsBySystem.set(pkg, new Set());
          }
          flowsBySystem.get(pkg).add(name);
          allFlows.add(name);
        }
      }
    });

    // Converti i Set in array e ordina
    const systemsList = Array.from(systems).sort();
    const flowsMap = {};
    
    flowsBySystem.forEach((flows, system) => {
      flowsMap[system] = Array.from(flows).sort();
    });

    const allFlowsList = Array.from(allFlows).sort();

    return res.json({
      ok: true,
      systems: systemsList,
      flows: flowsMap,
      allFlows: allFlowsList,
      sourceInterfacesCount: interfaces.length
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message,
      systems: [],
      flows: {},
      allFlows: []
    });
  }
});

app.get("/api/cache/messages", (req, res) => {
  const statusFilter = String(req.query.status || "").trim().toUpperCase();
  const systemFilter = String(req.query.system || "").trim();
  const includeUnknown = String(req.query.includeUnknown || "false").toLowerCase() === "true";
  const hasLimitParam = Object.prototype.hasOwnProperty.call(req.query || {}, "limit");
  const requestedLimit = hasLimitParam ? Number(req.query.limit) : cacheApiDefaultLimit;

  let items = messageCacheState.items.slice();

  if (!includeUnknown) {
    items = items.filter((item) => item.package && item.package !== "UNKNOWN");
  }

  if (statusFilter) {
    items = items.filter((item) => item.status === statusFilter);
  }

  if (systemFilter) {
    items = items.filter((item) => String(item.package) === systemFilter);
  }

  const totalCount = items.length;

  if (!Number.isNaN(requestedLimit) && requestedLimit > 0) {
    items = items.slice(0, requestedLimit);
  }

  return res.json({
    ok: true,
    count: items.length,
    totalCount,
    inProgress: messageCacheState.sync.inProgress,
    meta: messageCacheState.meta,
    items
  });
});

app.listen(port, () => {
  console.log(`CPI Guardian disponibile su http://localhost:${port}`);
});
