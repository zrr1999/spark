# @zendev-lab/spark-extension

Spark-native composition and policy boundary for the bundled Spark product
extension and `host-support` API used by TUI / headless hosts.

Spark apps should depend on this package, not `@zendev-lab/pi-extension`.
The Pi product continues to load `@zendev-lab/pi-extension` as a compatibility
facade. Shared mechanisms and durable stores belong in their capability
packages; this package owns only cross-capability registration and host policy.
