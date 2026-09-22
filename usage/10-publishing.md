# Publishing

Create a version tag matching `package.json`, such as `v0.1.0`. The release workflow waits for native/package tests and every real-model validation before building its npm artifact. Publishing stays disabled until the repository variable `NPM_PUBLISH_ENABLED` is `true`.

Before the first public release, establish ownership of the npm `teapilot` package and configure its [trusted publisher](https://docs.npmjs.com/trusted-publishers/) for GitHub user `fizzyhex`, repository `teapilot`, workflow `release.yml`. A first package publication may require the owner's npm login to establish the package. Subsequent tagged releases use OIDC and provenance; no long-lived npm token is stored in the repository. Keep the variable disabled until package ownership and public-release readiness are established. No release has been published by the setup implementation itself.

[Back to README](../README.md)
