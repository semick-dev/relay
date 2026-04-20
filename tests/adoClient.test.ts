import { afterEach, describe, expect, it, vi } from "vitest";

import { RelayAdoClient } from "../src/server/adoClient";

function jsonResponse(body: unknown, headers?: Record<string, string>) {
  return {
    ok: true,
    headers: {
      get(name: string) {
        return headers?.[name.toLowerCase()] ?? headers?.[name] ?? null;
      }
    },
    async json() {
      return body;
    },
    async text() {
      return JSON.stringify(body);
    }
  };
}

describe("RelayAdoClient queue metadata", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("parses YAML parameters from preview output when queue metadata is requested", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        id: 12,
        name: "demo",
        path: "\\",
        process: {
          type: 2,
          yamlFilename: "azure-pipelines.yml"
        },
        repository: {
          type: "GitHub",
          name: "semick-dev/locker",
          defaultBranch: "refs/heads/main"
        },
        variables: {
          keepMe: {
            value: "x",
            allowOverride: true
          }
        }
      }))
      .mockResolvedValueOnce(jsonResponse({
        finalYaml: [
          "parameters:",
          "- name: environment",
          "  type: string",
          "  default: dev",
          "  values:",
          "  - dev",
          "  - prod"
        ].join("\n")
      }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new RelayAdoClient("token");
    const metadata = await client.getDefinitionQueueMetadata("https://dev.azure.com/org", "proj", 12);

    expect(metadata).toMatchObject({
      id: 12,
      isYaml: true,
      yamlFilename: "azure-pipelines.yml",
      defaultBranch: "refs/heads/main",
      repositoryType: "GitHub",
      repositoryName: "semick-dev/locker",
      variables: [{
        name: "keepMe",
        value: "x",
        allowOverride: true,
        isSecret: false
      }],
      parameters: [{
        name: "environment",
        type: "string",
        label: "environment",
        defaultValue: "dev",
        required: false,
        options: [
          { label: "dev", value: "dev" },
          { label: "prod", value: "prod" }
        ]
      }]
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
