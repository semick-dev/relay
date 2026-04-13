# ADO Definition 12 Queue Notes

This note captures the working discovery and queue path for Azure DevOps build definition / pipeline `12` in:

- Organization: `https://sbeddall.visualstudio.com/`
- Project: `Investigations`
- UI URL: `https://sbeddall.visualstudio.com/Investigations/_build/index?definitionId=12`

## Summary

Definition `12` is a YAML pipeline, not a classic/designer build definition.

The wrong path, for this definition:

- `GET /Investigations/_apis/build/definitions/12/yaml?api-version=7.1-preview.1`

Observed response:

- HTTP `404`
- Message: `Build pipeline 12 is not designer.`

The working path is through the Pipelines REST API:

1. `GET /Investigations/_apis/pipelines/12?api-version=7.1`
2. `POST /Investigations/_apis/pipelines/12/preview?api-version=7.1`
3. `POST /Investigations/_apis/pipelines/12/runs?api-version=7.1`

## Confirmed Metadata

From `GET /_apis/build/definitions/12` and `GET /_apis/pipelines/12`:

- Definition/pipeline id: `12`
- Name: `Variables and Parameters`
- Process type: `2`
- YAML path: `.azure-pipelines/basic_test.yml`
- Repository type: `GitHub`
- Repository name: `semick-dev/locker`
- Default branch: `refs/heads/core`

## How To Retrieve Parameters

For this YAML pipeline, the usable parameter metadata came from:

- `POST /Investigations/_apis/pipelines/12/preview?api-version=7.1`

with body:

```json
{
  "previewRun": true,
  "resources": {
    "repositories": {
      "self": {
        "refName": "refs/heads/core"
      }
    }
  }
}
```

The response includes `finalYaml`. Parsing the `parameters:` block from that YAML produced the runtime parameter metadata.

## Confirmed Parameter

Parameter name:

- `CondaArtifacts`

Type:

- `object`

Default value:

```json
[
  {
    "name": "uamqp",
    "common_root": "uamqp",
    "in_batch": true,
    "checkout": [
      {
        "package": "uamqp",
        "download_uri": "https://files.pythonhosted.org/packages/0b/d8/fc24d95e6f6c80851ae6738c78da081cd535c924b02c5a4928b108b9ed42/uamqp-1.6.5.tar.gz"
      }
    ]
  }
]
```

Extracted from `preview.finalYaml`:

```yaml
parameters:
- name: CondaArtifacts
  type: object
  default:
  - name: uamqp
    common_root: uamqp
    in_batch: true
    checkout:
    - package: uamqp
      download_uri: https://files.pythonhosted.org/packages/0b/d8/fc24d95e6f6c80851ae6738c78da081cd535c924b02c5a4928b108b9ed42/uamqp-1.6.5.tar.gz
```

## How To Queue The Pipeline

The working queue endpoint was:

- `POST /Investigations/_apis/pipelines/12/runs?api-version=7.1`

Queue request using default branch and default parameter values:

```json
{
  "resources": {
    "repositories": {
      "self": {
        "refName": "refs/heads/core"
      }
    }
  },
  "templateParameters": {
    "CondaArtifacts": [
      {
        "name": "uamqp",
        "common_root": "uamqp",
        "in_batch": true,
        "checkout": [
          {
            "package": "uamqp",
            "download_uri": "https://files.pythonhosted.org/packages/0b/d8/fc24d95e6f6c80851ae6738c78da081cd535c924b02c5a4928b108b9ed42/uamqp-1.6.5.tar.gz"
          }
        ]
      }
    ]
  }
}
```

Queue request with explicit override:

```json
{
  "resources": {
    "repositories": {
      "self": {
        "refName": "refs/heads/core"
      }
    }
  },
  "templateParameters": {
    "CondaArtifacts": [
      {
        "name": "uamqp",
        "common_root": "uamqp",
        "in_batch": false,
        "checkout": [
          {
            "package": "uamqp",
            "download_uri": "https://files.pythonhosted.org/packages/0b/d8/fc24d95e6f6c80851ae6738c78da081cd535c924b02c5a4928b108b9ed42/uamqp-1.6.5.tar.gz"
          }
        ]
      }
    ]
  }
}
```

## Confirmed Queue Results

Successful runs queued during validation:

- Run `473`: queued with default/default-derived parameter payload
- Run `474`: queued with explicit `CondaArtifacts` override
- Run `475`: queued again after script cleanup

All were queued via:

- `POST /_apis/pipelines/12/runs`

## Implementation Notes For Future Merge

If this behavior is merged into the actual source, the important behavior is:

1. Detect YAML pipelines (`process.type === 2` or Pipelines API presence).
2. Do not rely on `build/definitions/{id}/yaml` for non-designer pipelines.
3. Use `pipelines/{id}/preview` to materialize `finalYaml`.
4. Parse the `parameters:` block from `finalYaml` to recover:
   - parameter name
   - parameter type
   - default value
5. Queue via `pipelines/{id}/runs`.
6. Send branch as `refs/heads/core` or the resolved default branch.
7. Send runtime values in `templateParameters`, not legacy `builds.parameters`.

## Local Probe Script

The local script used to validate this is:

- [example-queue.js](plans/example-queue.js:1)

Useful commands:

```bash
node example-queue.js inspect
node example-queue.js preview
node example-queue.js queue-pipeline
node example-queue.js queue-pipeline CondaArtifacts '[{"name":"uamqp","common_root":"uamqp","in_batch":false,"checkout":[{"package":"uamqp","download_uri":"https://files.pythonhosted.org/packages/0b/d8/fc24d95e6f6c80851ae6738c78da081cd535c924b02c5a4928b108b9ed42/uamqp-1.6.5.tar.gz"}]}]'
```

## Documentation References

- [Pipelines - Get](https://learn.microsoft.com/en-us/rest/api/azure/devops/pipelines/pipelines/get?view=azure-devops-rest-7.1)
- [Runs - Run Pipeline](https://learn.microsoft.com/en-us/rest/api/azure/devops/pipelines/runs/run-pipeline?view=azure-devops-rest-7.1)
- [YAML parameter schema](https://learn.microsoft.com/en-us/azure/devops/pipelines/yaml-schema/parameters-parameter?view=azure-pipelines)
