# Changelog

All notable changes to this project are documented here. This file is generated
by [semantic-release](https://semantic-release.gitbook.io) from Conventional
Commit messages — do not edit it by hand.

## [0.3.0](https://github.com/nothingrotf/pi-fusiontui/compare/v0.2.1...v0.3.0) (2026-07-27)

### 🚀 New Features

* **droid:** add /fusion-droid to toggle the droid transcript skin ([d5ae42e](https://github.com/nothingrotf/pi-fusiontui/commit/d5ae42ec7cdd85bce8251291d2b2a951c0e813ca))
* **themes:** add the kaku-dark theme ([4b30d33](https://github.com/nothingrotf/pi-fusiontui/commit/4b30d33e8a28df24a46e2807a47113534df0eec3))

### 📚 Documentation

* **rpiv:** add the droid-skin-toggle pipeline artifacts ([09a483f](https://github.com/nothingrotf/pi-fusiontui/commit/09a483f3118bcb043ca6f19124e8f08b723a43b2))

## [0.2.1](https://github.com/nothingrotf/pi-fusiontui/compare/v0.2.0...v0.2.1) (2026-07-25)

### 🐛 Bug Fixes

* **droid:** keep OSC 133 markers intact and correctly ordered ([329e268](https://github.com/nothingrotf/pi-fusiontui/commit/329e268965ae3d69fddde1fda937a6f5342cf301))

### ♻️ Refactors

* **droid:** split the 1267-line skin into modules by concern ([27b2e93](https://github.com/nothingrotf/pi-fusiontui/commit/27b2e9384a0a0caea990bf80f8613d05728032c7))

### 📚 Documentation

* document the test layout and add a coverage script ([146aa1c](https://github.com/nothingrotf/pi-fusiontui/commit/146aa1c56ebd863092ae4cba158e6ba16b52ce55))

## [0.2.0](https://github.com/nothingrotf/pi-fusiontui/compare/v0.1.0...v0.2.0) (2026-07-25)

### 🚀 New Features

* add completion sound notifications ([a38a39b](https://github.com/nothingrotf/pi-fusiontui/commit/a38a39b181052ca31c49667fbb06f565225a3093))
* **config:** add full/minimal/adaptive footer modes via /fusion ([35f460b](https://github.com/nothingrotf/pi-fusiontui/commit/35f460b32bb3dfd7a233164202e6c85850fbd45f))
* **editor:** add droid-style bubble editor with chevron and aligned autocomplete ([bd0b749](https://github.com/nothingrotf/pi-fusiontui/commit/bd0b74926fc07a87718c56b0fcafaec286b6348c))
* **editor:** compose displaced editor owners instead of evicting them ([949323a](https://github.com/nothingrotf/pi-fusiontui/commit/949323af8da55a248b34e08e1d65ca5d685b5629))
* **editor:** tint idle border with theme accent ([8117c7d](https://github.com/nothingrotf/pi-fusiontui/commit/8117c7d65af4189f50b0dd9304462a61e83f486a))
* **footer:** add single-line starship-style statusline ([61865c9](https://github.com/nothingrotf/pi-fusiontui/commit/61865c9f5d21e336ae37f28c977d5f3044314502))
* **footer:** render extension statuses set via ctx.ui.setStatus ([7a4ba29](https://github.com/nothingrotf/pi-fusiontui/commit/7a4ba29b31e8c8c96a06e725f871008b464fcc4e))
* **footer:** show pi-codex-goal status on its own line ([5871474](https://github.com/nothingrotf/pi-fusiontui/commit/587147489a7753a1631fcb71520b1a775bd317de))
* **format:** add token, cost, model and effort formatters ([6ae6983](https://github.com/nothingrotf/pi-fusiontui/commit/6ae69839b0fa6809163565535c6af684836e95ae))
* **git:** add porcelain git status parser ([89742fd](https://github.com/nothingrotf/pi-fusiontui/commit/89742fd4480a1173e25229abc01eeca58d51683f))
* replicate Droid transcript skin and awaiting-input notifications ([791d912](https://github.com/nothingrotf/pi-fusiontui/commit/791d912bdbffe53bfecc8a770eb37121681c6be9))
* **state:** add shared render state ([efa8a94](https://github.com/nothingrotf/pi-fusiontui/commit/efa8a94525084bab4b1c82439925540590caeeb5))
* **theme:** add safe color helpers and progress bars ([459b056](https://github.com/nothingrotf/pi-fusiontui/commit/459b056908564e35d46e53839566e0f0b56215d8))
* **theme:** bundle Evangelion-inspired dark/light themes ([d4b7bcf](https://github.com/nothingrotf/pi-fusiontui/commit/d4b7bcfaca889856a68e64eca9b19e4a8f3a111d))
* **usage:** add anthropic oauth and codex usage fetchers ([e219601](https://github.com/nothingrotf/pi-fusiontui/commit/e219601bdfa7ee02d9c548cf4eaeca2551d22a6b))
* wire footer and editor into the extension entrypoint ([1126b42](https://github.com/nothingrotf/pi-fusiontui/commit/1126b42a7fdd8c7c44cb3c9ab147ff6928c86e5d))

### 🐛 Bug Fixes

* **build:** guard husky in prepare so --omit=dev installs succeed ([05f9c33](https://github.com/nothingrotf/pi-fusiontui/commit/05f9c33cb1dda655bad098fa8a7402a7f816fec6))
* **editor:** recognize scroll-indicator borders so long pastes do not blank the box ([3780ab8](https://github.com/nothingrotf/pi-fusiontui/commit/3780ab89676a331e00d182e46feb5709f4898d8d))
* **footer:** move usage to second line on narrow widths ([2fe8942](https://github.com/nothingrotf/pi-fusiontui/commit/2fe894272fc9e151384a23b068e3d175b5772cd7))
* **footer:** restore missing git-branch glyph in branch segment ([c2657b3](https://github.com/nothingrotf/pi-fusiontui/commit/c2657b3ec78a92e05201ca995b4fcbb4f7eb2105))
* **footer:** stop UI freeze from scroll-lock raw mouse tracking ([0a3ca8a](https://github.com/nothingrotf/pi-fusiontui/commit/0a3ca8a9d1eb6b484e1d90ed0d7cbaa540c854e9))
* **footer:** wrap to two lines on narrow widths instead of truncating ([f191d42](https://github.com/nothingrotf/pi-fusiontui/commit/f191d425e9ea35f0c9c62097591aeee941fe225e))
* harden rendering boundaries and extension lifecycle ([4ab3e97](https://github.com/nothingrotf/pi-fusiontui/commit/4ab3e97820b33efce19a0a8dd6d3fcc87751210c))
* preserve transcript reading position during streaming ([00bda59](https://github.com/nothingrotf/pi-fusiontui/commit/00bda59e651956d742254a90659a84c04a2082a1))
* **release:** pin semantic-release plugins so release notes render ([1676e7e](https://github.com/nothingrotf/pi-fusiontui/commit/1676e7e463968d41e06ac982b3fa9a1e99ef900a))
* skin edit tool cards consistently ([7a9498f](https://github.com/nothingrotf/pi-fusiontui/commit/7a9498f11fa074d89077379a5b9395081c3dd19a))

### 📚 Documentation

* add rendering/TUI architecture review artifact ([38cd202](https://github.com/nothingrotf/pi-fusiontui/commit/38cd20267608c047417d2bba671621933a9cf84e))
* document features, layout and contributing guide ([34936f3](https://github.com/nothingrotf/pi-fusiontui/commit/34936f31f38a989e9cce083a40e6c90098fff632))
* document the lint, CI and automated release workflow ([4b97a50](https://github.com/nothingrotf/pi-fusiontui/commit/4b97a50f82478240d0b4386e0655e6b380429ed7))

### 🏗️ Build & Dependencies

* **deps:** add commitlint and husky lockfile ([1a1fe96](https://github.com/nothingrotf/pi-fusiontui/commit/1a1fe96b6c7bebb54aa9165ce13d025bff5a4fef))
* **deps:** bump pi peer packages to 0.81.1 ([f7290be](https://github.com/nothingrotf/pi-fusiontui/commit/f7290bebb535f445b1c68a6720204bb017175b1c))
