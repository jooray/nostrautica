# Versioning

Nostrautica currently has package versions with different purposes; they are not mechanically synchronized.

| Field | Current value | Meaning |
|---|---:|---|
| Root `package.json` | `0.6.5` | Repository/product release label for this private monorepo. |
| `@nostrautica/app` | `0.6.7` | PWA package version and service-worker deployment revision input. |
| `@nostrautica/protocol` | `0.1.0` | Shared protocol package API version. |
| `@nostrautica/coordinator` | `0.1.0` | Coordinator package API version. |
| Git tag / deployed artifact | Not mechanically tied today | Release/deployment identifier recorded by the release process. |

For a release, record the Git commit/tag, app package version, deployed app URL, and coordinator revision together. Do not infer that equal or unequal package versions prove compatibility; use the protocol registry and tested release commit.
