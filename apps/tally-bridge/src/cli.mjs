import { createTallyBridgeServer, readBridgeConfig } from "./bridge.mjs"

const config = readBridgeConfig()
const server = createTallyBridgeServer(config)

server.listen(config.bridgePort, "127.0.0.1", () => {
  console.log(`Synapse Tally Bridge listening at http://127.0.0.1:${config.bridgePort}`)
  console.log(`Tally XML target: ${config.tallyUrl.origin}`)
  console.log(`Allowed portal origins: ${[...config.allowedOrigins].join(", ")}`)
  console.log("Exports are read-only and remain staged until a pharmacy administrator applies them.")
})

server.on("error", (error) => {
  console.error("Synapse Tally Bridge failed to start:", error.message)
  process.exitCode = 1
})

function stop() {
  server.close(() => process.exit())
}

process.once("SIGINT", stop)
process.once("SIGTERM", stop)
