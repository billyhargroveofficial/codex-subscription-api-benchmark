# Third-party dependencies

The benchmark imports the published `@earendil-works/pi-coding-agent` and
`@earendil-works/pi-ai` packages, version 1.0.2 (MIT license metadata), from
the [Pi project](https://github.com/earendil-works/pi). Their upstream authors
retain copyright. Provider source and dependency binaries are not copied into
this repository; npm installs them separately under their own license terms.

TypeScript (Apache-2.0) and Node type declarations (MIT) are development
dependencies. `package-lock.json` pins the resolved graph. The generated
`dependency-licenses.json` inventories names, versions and license metadata
from the installed graph, including transitive packages. It is a metadata
inventory, not a substitute for the license/NOTICE files distributed by each
package. Platform-specific optional packages can differ on other systems.

The synthetic workload and benchmark implementation were created for this
project. The project's MIT license does not relicense upstream dependencies.
The credential adapter follows Codex's documented source format; it does not
vendor the Codex Rust implementation or claim to be an official client.
