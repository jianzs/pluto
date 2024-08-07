# @plutolang/static-deducer

## 0.4.12

### Patch Changes

- Updated dependencies [8f0e48d]
  - @plutolang/base@0.4.9

## 0.4.11

### Patch Changes

- Updated dependencies [c8dfa7a]
  - @plutolang/base@0.4.8

## 0.4.10

### Patch Changes

- Updated dependencies [b277a26]
  - @plutolang/base@0.4.7

## 0.4.9

### Patch Changes

- Updated dependencies [4e5b0b1]
  - @plutolang/base@0.4.6

## 0.4.8

### Patch Changes

- 6f75db8: refactor(base): refactor architecture reference data structure

  Refine the argument type for adding resources to capture property types, clarifying usage. Redefine the three Relationship types for improved code readability and to clarify resource relationships across various scenarios.

- Updated dependencies [6f75db8]
- Updated dependencies [339dcfb]
  - @plutolang/base@0.4.5

## 0.4.7

### Patch Changes

- Updated dependencies [87f35b5]
  - @plutolang/base@0.4.4

## 0.4.6

### Patch Changes

- b3400ad: feat(deducer): allow using direct captured properties as arguments in infra API

  This change introduces the ability to use direct captured properties as arguments in infrastructure API calls. For instance, the code below is now considered valid:

  ```python
  from pluto_client import Website, Router

  router = Router("router")
  website = Website(path="path/to/website", name="website")

  website.addEnv("ROUTER", router.url())
  ```

  In this example, `router.url()` is a direct captured property which the website utilizes to establish a connection to the backend service.

  The goal is for the infrastructure API to accept both direct captured properties and variables assigned with these properties, as demonstrated here:

  ```python
  from pluto_client import Website, Router

  router = Router("router")
  website = Website(path="path/to/website", name="website")

  router_url = router.url()
  website.addEnv("ROUTER", router_url)
  ```

  Currently, the API only accepts direct captured properties as arguments. Future updates will include support for variables that store the return values of these properties.

## 0.4.5

### Patch Changes

- 4cfb9a8: feat(deducer): use the `name` parameter from the new expression as the resource object name

  Previously, the resource object's name was derived from the resource variable name, causing discrepancies between compilation and runtime. This update utilizes the `name` parameter from the new expression for naming the resource object during compilation, defaulting to `default` when not provided.

## 0.4.4

### Patch Changes

- Updated dependencies [0a01098]
  - @plutolang/base@0.4.3

## 0.4.3

### Patch Changes

- Updated dependencies [8819258]
  - @plutolang/base@0.4.2

## 0.4.2

### Patch Changes

- Updated dependencies [2a0a874]
  - @plutolang/base@0.4.1

## 0.4.1

### Patch Changes

- daa6ef9: fix(deducer): incorrectly generate duplicate client statements when one code section accesses a single resource multiple times

## 0.4.0

### Minor Changes

- 1c3c5fa: feat: python support, validated with quickstart

  We created a deducer using Pyright. It can automatically analyze the dependent packages for each section of business logic, and the adapter includes them in the zip archive for publishing on AWS Lambda.

  Currently, Pluto supports simple Python projects. Users can use the pluto command to create and deploy Python projects. However, if the project relies on packages with different distribution packages on various platforms, or if the archive size after zipping exceeds the AWS limit of 50 MB, it will fail.

  For more details, you can find in the PRs related to the issue https://github.com/pluto-lang/pluto/issues/146 .

### Patch Changes

- 11ecc36: feat: support python workflow
- Updated dependencies [1c3c5fa]
- Updated dependencies [11ecc36]
  - @plutolang/base@0.4.0

## 0.3.1

### Patch Changes

- Updated dependencies [d285a49]
  - @plutolang/base@0.3.1

## 0.3.0

### Minor Changes

- cc4fd80: feat: closure mode support, architecture reference structure enhancements, user custom function resource support

  - Closure Mode Support: Comprehensive modifications have been made to add support for closure mode. These include updates to the SDK for various cloud platforms, enhancing the deducer's closure analysis capabilities, incorporating closure import statements in the generated IaC code, and more.
  - Architectural Reference Structure Enhancements: The architectural reference structure now includes closure items. The CLI, generator, and deducer have been adjusted to align with the updated architectural reference structure.
  - User Custom Function Resource: Support has been added for user custom function resources on Alicloud, AWS, and Kubernetes.
  - Documentation Updates: The documentation has been revised to reflect these changes.

### Patch Changes

- Updated dependencies [cc4fd80]
  - @plutolang/base@0.3.0

## 0.2.9

### Patch Changes

- Updated dependencies [fe44c8e]
  - @plutolang/base@0.2.9

## 0.2.8

### Patch Changes

- Updated dependencies [62a0009]
  - @plutolang/base@0.2.8

## 0.2.7

### Patch Changes

- 5ae1dec: feat: support for transfering the values generated by compile-time to runtime

  Note: it hasn't supported for simulation testing yet, but it already can be used on the cloud platform.

- Updated dependencies [5ae1dec]
  - @plutolang/base@0.2.7

## 0.2.6

### Patch Changes

- bf60683: enhance(adapter): split the adapter package
- Updated dependencies [bf60683]
  - @plutolang/base@0.2.6

## 0.2.5

### Patch Changes

- Updated dependencies [0d8fc6f]
  - @plutolang/base@0.2.5

## 0.2.4

### Patch Changes

- 5736dc1: enhance: refactor the component apis
- 38eef8e: enhance: normalize the configuration models, including project and stack.
- Updated dependencies [5736dc1]
- Updated dependencies [38eef8e]
  - @plutolang/base@0.2.4

## 0.2.3

### Patch Changes

- Updated dependencies [3401159]
  - @plutolang/base@0.2.3

## 0.2.2

### Patch Changes

- Updated dependencies [c2bcfb6]
  - @plutolang/base@0.2.2

## 0.2.1

### Patch Changes

- Updated dependencies [a5539e6]
  - @plutolang/base@0.2.1

## 0.2.0

### Minor Changes

- 505de47: https://github.com/pluto-lang/pluto/releases/tag/v0.2.0

### Patch Changes

- Updated dependencies [505de47]
  - @plutolang/base@0.2.0

## 0.1.3

### Patch Changes

- 6f2d1d5: feat(deducer): support calling function that is located outside of the function scope

## 0.1.2

### Patch Changes

- de25ad5: feat(deducer,generator): support accessing the constants that located outside of the function scope"
- Updated dependencies [de25ad5]
  - @plutolang/base@0.1.1

## 0.1.1

### Patch Changes

- e587e81: feat(deducer): support dynamically detecting resource type

## 0.1.0

### Minor Changes

- 055b3c7: Release 0.1.0

### Patch Changes

- Updated dependencies [055b3c7]
  - @plutolang/base@0.1.0

## 0.0.5

### Patch Changes

- fac0e1e: Fix: static deducer of the published version depends on vitest.

## 0.0.4

### Patch Changes

- 77ec0ba: Support dependency analysis for package-related cases.

## 0.0.3

### Patch Changes

- c504f5b: Support schedule resource on AWS and K8s.

## 0.0.2

### Patch Changes

- rename @pluto to @plutolang
- Updated dependencies
  - @plutolang/base@0.0.2

## 0.0.1

### Patch Changes

- first release
- Updated dependencies
  - @pluto/base@0.0.1
