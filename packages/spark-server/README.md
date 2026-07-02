# @zendev-lab/spark-server

Spark server is the coordination-plane package for Cockpit-hosted server logic. It owns runtime
registration/token handling, runtime WebSocket command delivery, projection ingestion, command
outbox writes, event queries, and read-side Cockpit query models.

Execution truth stays in the Spark daemon. This package adapts server transports and projection
state; it must not bypass daemon dispatch for runtime work.
