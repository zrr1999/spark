import { createServer } from "node:http";

const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT);
const server = createServer((_request, response) => {
  response.end("ok");
});

const stop = () => server.close();
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
server.listen(port, host);
