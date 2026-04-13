#!/usr/bin/env node

const { parseDocument } = require("yaml");

const ORG_URL = "https://sbeddall.visualstudio.com/";
const PROJECT = "Investigations";
const DEFINITION_ID = 12;
const API_VERSION = "7.1";
const DEFAULT_BRANCH = "refs/heads/core";

const mode = process.argv[2] || "inspect";
const requestedParamName = process.argv[3];
const requestedParamValue = process.argv[4];

async function main() {
  const token = process.env.ADO_TOKEN;
  if (!token) {
    throw new Error("ADO_TOKEN is not configured.");
  }

  const definition = await getJson(token, buildUrl(`${enc(PROJECT)}/_apis/build/definitions/${DEFINITION_ID}`, {
    "api-version": API_VERSION
  }));

  await emitOtelEvent("definition.loaded", {
    definitionId: DEFINITION_ID,
    processType: definition.process?.type,
    defaultBranch: definition.repository?.defaultBranch || null
  });

  const inspection = await inspectDefinition(token, definition);
  printInspection(inspection);

  if (mode === "inspect") {
    return;
  }

  if (mode === "inspect-pipeline") {
    const pipeline = await getJson(token, buildUrl(`${enc(PROJECT)}/_apis/pipelines/${DEFINITION_ID}`, {
      "api-version": API_VERSION
    }));
    console.log(JSON.stringify(pipeline, null, 2));
    return;
  }

  if (mode === "preview") {
    const payload = buildPipelinePreviewPayload(requestedParamName, requestedParamValue);
    const preview = await postJson(token, buildUrl(`${enc(PROJECT)}/_apis/pipelines/${DEFINITION_ID}/preview`, {
      "api-version": API_VERSION
    }), payload);
    console.log(JSON.stringify(preview, null, 2));
    return;
  }

  if (mode === "queue-build") {
    const payload = buildLegacyQueuePayload(definition, inspection, requestedParamName, requestedParamValue);
    const queued = await postJson(token, buildUrl(`${enc(PROJECT)}/_apis/build/builds`, {
      "api-version": API_VERSION
    }), payload);
    console.log(JSON.stringify({
      mode,
      endpoint: "builds",
      queuedBuildId: queued.id,
      status: queued.status,
      sourceBranch: queued.sourceBranch,
      parameters: queued.parameters
    }, null, 2));
    return;
  }

  if (mode === "queue-pipeline") {
    const payload = buildPipelineQueuePayload(inspection, requestedParamName, requestedParamValue);
    const queued = await postJson(token, buildUrl(`${enc(PROJECT)}/_apis/pipelines/${DEFINITION_ID}/runs`, {
      "api-version": API_VERSION
    }), payload);
    console.log(JSON.stringify({
      mode,
      endpoint: "pipelines/runs",
      queuedRunId: queued.id,
      state: queued.state,
      result: queued.result,
      url: queued.url || null
    }, null, 2));
    return;
  }

  throw new Error(`Unknown mode: ${mode}`);
}

async function inspectDefinition(token, definition) {
  const processParameters = parseJsonMaybe(definition.processParameters);
  const classicInputs = Array.isArray(processParameters?.inputs) ? processParameters.inputs : [];
  const definitionParameters = parseJsonMaybe(definition.parameters);
  const preview = await getPreview(token);
  const previewParameters = preview?.finalYaml ? extractYamlParameters(preview.finalYaml) : [];

  let yamlText = null;
  let yamlParameters = [];
  let yamlError = null;

  try {
    yamlText = await getText(token, buildUrl(`${enc(PROJECT)}/_apis/build/definitions/${DEFINITION_ID}/yaml`, {
      "api-version": "7.1-preview.1"
    }));
    yamlParameters = extractYamlParameters(yamlText);
  } catch (error) {
    yamlError = error instanceof Error ? error.message : String(error);
  }

  return {
    id: definition.id,
    name: definition.name,
    path: definition.path || "\\",
    queueStatus: definition.queueStatus || null,
    processType: definition.process?.type ?? null,
    processYamlFilename: definition.process?.yamlFilename || null,
    repository: {
      id: definition.repository?.id || null,
      name: definition.repository?.name || null,
      type: definition.repository?.type || null,
      defaultBranch: definition.repository?.defaultBranch || null
    },
    processParametersRawType: typeof definition.processParameters,
    processParameters,
    classicInputs: classicInputs.map((input) => ({
      name: input.name || null,
      type: input.type || null,
      label: input.label || null,
      defaultValue: input.defaultValue,
      required: Boolean(input.required),
      options: input.options || null
    })),
    definitionParameters,
    preview: {
      available: Boolean(preview),
      parameters: previewParameters,
      finalYaml: preview?.finalYaml || null
    },
    yaml: {
      available: Boolean(yamlText),
      error: yamlError,
      parameters: yamlParameters
    }
  };
}

function buildLegacyQueuePayload(definition, inspection, paramName, paramValue) {
  const parameters = {};
  if (paramName) {
    parameters[paramName] = coerceMaybeYaml(paramValue);
  } else {
    for (const input of inspection.classicInputs) {
      if (input.name && input.defaultValue !== undefined) {
        parameters[input.name] = input.defaultValue;
      }
    }
  }

  return {
    definition: {
      id: definition.id
    },
    sourceBranch: DEFAULT_BRANCH,
    parameters: JSON.stringify(parameters)
  };
}

function buildPipelineQueuePayload(inspection, paramName, paramValue) {
  const templateParameters = {};
  if (paramName) {
    templateParameters[paramName] = coerceMaybeYaml(paramValue);
  } else {
    const parameters = inspection.preview.parameters.length > 0
      ? inspection.preview.parameters
      : inspection.yaml.parameters;
    for (const parameter of parameters) {
      if (parameter.name && parameter.default !== undefined) {
        templateParameters[parameter.name] = parameter.default;
      }
    }
  }

  return {
    resources: {
      repositories: {
        self: {
          refName: DEFAULT_BRANCH
        }
      }
    },
    templateParameters
  };
}

function buildPipelinePreviewPayload(paramName, paramValue) {
  const templateParameters = {};
  if (paramName) {
    templateParameters[paramName] = coerceMaybeYaml(paramValue);
  }

  return {
    previewRun: true,
    resources: {
      repositories: {
        self: {
          refName: DEFAULT_BRANCH
        }
      }
    },
    templateParameters
  };
}

function extractYamlParameters(yamlText) {
  const document = parseDocument(yamlText);
  const root = document.contents;
  if (!root || typeof root.get !== "function") {
    return [];
  }

  const parametersNode = root.get("parameters", true);
  if (!parametersNode) {
    return [];
  }

  if (Array.isArray(parametersNode.items)) {
    return parametersNode.items.map((item) => {
      const js = typeof item?.toJSON === "function" ? item.toJSON() : item;
      return {
        name: js?.name || null,
        type: js?.type || inferJsType(js?.default),
        default: js?.default,
        values: js?.values || null
      };
    });
  }

  const js = typeof parametersNode.toJSON === "function" ? parametersNode.toJSON() : parametersNode;
  if (!js || typeof js !== "object") {
    return [];
  }

  return Object.entries(js).map(([name, value]) => ({
    name,
    type: inferJsType(value),
    default: value,
    values: null
  }));
}

function inferJsType(value) {
  if (Array.isArray(value)) {
    return "array";
  }
  if (value === null) {
    return "null";
  }
  return typeof value;
}

function parseJsonMaybe(value) {
  if (!value) {
    return null;
  }
  if (typeof value !== "string") {
    return value;
  }
  try {
    return JSON.parse(value);
  } catch {
    return {
      _raw: value
    };
  }
}

function coerceMaybeYaml(value) {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }

  const trimmed = String(value).trim();
  if (!trimmed) {
    return "";
  }

  try {
    return parseDocument(trimmed).toJS();
  } catch {
    return value;
  }
}

function printInspection(inspection) {
  console.log(JSON.stringify(inspection, null, 2));
}

function buildUrl(path, query) {
  const url = new URL(path, ORG_URL);
  for (const [key, value] of Object.entries(query || {})) {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

async function getJson(token, url) {
  return await request(token, url, {
    headers: {
      Accept: "application/json"
    }
  });
}

async function postJson(token, url, body) {
  return await request(token, url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
}

async function getText(token, url) {
  const response = await fetch(url, {
    headers: {
      Authorization: `Basic ${Buffer.from(`:${token}`, "utf8").toString("base64")}`,
      Accept: "text/plain, application/yaml, text/yaml, application/json"
    }
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText} for ${url}: ${(await response.text()).trim()}`);
  }

  return await response.text();
}

async function getPreview(token) {
  return await postJson(token, buildUrl(`${enc(PROJECT)}/_apis/pipelines/${DEFINITION_ID}/preview`, {
    "api-version": API_VERSION
  }), {
    previewRun: true,
    resources: {
      repositories: {
        self: {
          refName: DEFAULT_BRANCH
        }
      }
    }
  });
}

async function request(token, url, init) {
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Basic ${Buffer.from(`:${token}`, "utf8").toString("base64")}`,
      ...(init?.headers || {})
    }
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText} for ${url}: ${(await response.text()).trim()}`);
  }

  return await response.json();
}

async function emitOtelEvent(name, attributes) {
  const base = process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT || process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!base) {
    return;
  }

  const url = base.endsWith("/v1/logs") ? base : `${base.replace(/\/$/, "")}/v1/logs`;
  const body = {
    resourceLogs: [{
      resource: {
        attributes: [
          { key: "service.name", value: { stringValue: "relay-example-queue" } }
        ]
      },
      scopeLogs: [{
        scope: {
          name: "example-queue.js"
        },
        logRecords: [{
          timeUnixNano: String(BigInt(Date.now()) * 1000000n),
          severityText: "INFO",
          body: {
            stringValue: name
          },
          attributes: Object.entries(attributes || {}).map(([key, value]) => ({
            key,
            value: otelValue(value)
          }))
        }]
      }]
    }]
  };

  try {
    await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });
  } catch {
  }
}

function otelValue(value) {
  if (typeof value === "boolean") {
    return { boolValue: value };
  }
  if (typeof value === "number") {
    return { doubleValue: value };
  }
  if (value === null || value === undefined) {
    return { stringValue: "" };
  }
  return { stringValue: typeof value === "string" ? value : JSON.stringify(value) };
}

function enc(value) {
  return encodeURIComponent(value);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
