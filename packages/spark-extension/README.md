# @zendev-lab/spark-extension

Spark-native host boundary for the bundled Spark product extension and
`host-support` API used by TUI / headless hosts.

Spark apps should depend on this package, not `@zendev-lab/pi-extension`.
The Pi product continues to load `@zendev-lab/pi-extension` as a compatibility
facade. Policy implementations migrate incrementally into capability packages;
this package stays a thin re-export / registration boundary.
